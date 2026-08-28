#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')
COMPOSE_PROJECT_NAME="station-smoke-${RUN_TOKEN}"
export COMPOSE_PROJECT_NAME
compose=(docker compose -f "$ROOT/docker-compose.yml")
SHA=${STATION_RELEASE_SHA:-$(git -C "$ROOT" rev-parse HEAD)}
REF=${STATION_RELEASE_REF:-$(git -C "$ROOT" describe --tags --exact-match "$SHA" 2>/dev/null || printf 'v0.0.0-preview.1')}
CREATED_AT_INPUT=${STATION_RELEASE_CREATED_AT:-$(git -C "$ROOT" show -s --format=%ct "$SHA")}
CREATED_AT=$(node -e 'const value=process.argv[1]; const epochSeconds=Number(value); const date=value.trim()!==""&&Number.isFinite(epochSeconds)?new Date(epochSeconds*1000):new Date(value); if(!Number.isFinite(date.valueOf())) throw new Error("invalid release creation time"); process.stdout.write(date.toISOString())' "$CREATED_AT_INPUT")
REPOSITORY=${STATION_IMAGE_REPOSITORY:-kontourai/station}
STATION_IMAGE="station-container-smoke:${SHA}-${RUN_TOKEN}"
export STATION_IMAGE

if [[ ! "$SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo 'container smoke requires a 40-character STATION_RELEASE_SHA' >&2
  exit 1
fi
node "$ROOT/scripts/lib/container-release-metadata.mjs" \
  --tag="$REF" --sha="$SHA" --created-at="$CREATED_AT" \
  --repository="$REPOSITORY" >/dev/null

existing_resources=$(
  {
    docker ps --all --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
    docker network ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
    docker volume ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
  } | sed '/^$/d'
)
if [[ -n "$existing_resources" ]]; then
  echo "refusing to reuse existing Compose project: $COMPOSE_PROJECT_NAME" >&2
  exit 1
fi

WORKSPACE=$(mktemp -d "${TMPDIR:-/tmp}/station-container-workspace.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  cleanup_failed=0
  if ! "${compose[@]}" down --remove-orphans >/dev/null 2>&1; then
    echo "Compose teardown failed for $COMPOSE_PROJECT_NAME" >&2
    cleanup_failed=1
  fi
  for volume in $(docker volume ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"); do
    owner=$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$volume" 2>/dev/null || true)
    if [[ "$owner" != "$COMPOSE_PROJECT_NAME" ]]; then
      echo "refusing to remove unowned smoke volume: $volume" >&2
      cleanup_failed=1
      continue
    fi
    docker volume rm "$volume" >/dev/null || cleanup_failed=1
  done
  remaining_resources=$(
    {
      docker ps --all --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
      docker network ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
      docker volume ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"
    } | sed '/^$/d'
  )
  if [[ -n "$remaining_resources" ]]; then
    echo "Smoke teardown left owned resources for $COMPOSE_PROJECT_NAME" >&2
    cleanup_failed=1
  fi
  if docker image inspect "$STATION_IMAGE" >/dev/null 2>&1; then
    image_owner=$(docker image inspect --format '{{ index .Config.Labels "com.kontourai.station.container-smoke" }}' "$STATION_IMAGE" 2>/dev/null || true)
    if [[ "$image_owner" != "$COMPOSE_PROJECT_NAME" ]]; then
      echo "refusing to remove unowned smoke image: $STATION_IMAGE" >&2
      cleanup_failed=1
    elif ! docker image rm "$STATION_IMAGE" >/dev/null; then
      echo "Smoke teardown could not remove owned image: $STATION_IMAGE" >&2
      cleanup_failed=1
    fi
  fi
  rm -rf "$WORKSPACE"
  if (( cleanup_failed != 0 && status == 0 )); then
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

printf 'station container sentinel\n' > "$WORKSPACE/container-sentinel.txt"
chmod 0755 "$WORKSPACE"
export STATION_RELEASE_SHA="$SHA"
export STATION_RELEASE_REF="$REF"
export STATION_RELEASE_CREATED_AT="$CREATED_AT"
export STATION_WORKSPACE_DIR="$WORKSPACE"
export STATION_UI_PORT=${STATION_UI_PORT:-$(node -e 'require("node:net").createServer().listen(0,"127.0.0.1",function(){console.log(this.address().port);this.close()})')}
export STATION_ALLOWED_ORIGINS="http://127.0.0.1:${STATION_UI_PORT}"

build_log="$WORKSPACE/docker-build.log"
if ! docker build --pull --progress=plain --tag "$STATION_IMAGE" \
  --label "com.kontourai.station.container-smoke=$COMPOSE_PROJECT_NAME" \
  --build-arg "STATION_RELEASE_SHA=$STATION_RELEASE_SHA" \
  --build-arg "STATION_RELEASE_REF=$STATION_RELEASE_REF" \
  --build-arg "STATION_RELEASE_CREATED_AT=$STATION_RELEASE_CREATED_AT" \
  --build-arg "STATION_IMAGE_REPOSITORY=$REPOSITORY" \
  "$ROOT" >"$build_log" 2>&1; then
  cat "$build_log" >&2
  echo 'container image build failed' >&2
  exit 1
fi
docker run --rm --entrypoint sh "$STATION_IMAGE" -c '
  app_paths="/app/packages /app/src-server /app/src-shared /app/scripts /app/schemas"
  if find $app_paths -path "*/node_modules/*" -prune -o \( -path "*/__tests__/*" -o -path "*/fixtures/*" -o -name "*.test.*" -o -name "*.spec.*" \) -print | grep -q .; then
    echo "runtime image contains application test or fixture files" >&2
    exit 1
  fi
  if grep -RIlE --include="*.pem" --include="*.key" "BEGIN .*PRIVATE KEY" $app_paths | grep -q .; then
    echo "runtime image contains application private-key material" >&2
    exit 1
  fi
'
"${compose[@]}" up -d station

deadline=$((SECONDS + 90))
until identity=$(curl --fail --silent --show-error "http://127.0.0.1:${STATION_UI_PORT}/__station/identity"); do
  if (( SECONDS >= deadline )); then
    "${compose[@]}" logs --no-color station >&2 || true
    echo 'container identity did not become ready' >&2
    exit 1
  fi
  sleep 1
done
node -e 'const identity=JSON.parse(process.argv[1]); if(identity.sha !== process.argv[2]) throw new Error(`unexpected image SHA: ${identity.sha}`)' "$identity" "$SHA"

credential=$("${compose[@]}" exec -T station sh -c 'STATION_HOME=/data/station ./station environment credential show')
test -n "$credential"
deadline=$((SECONDS + 90))
until curl --fail --silent \
  --header "Authorization: Bearer $credential" \
  "http://127.0.0.1:${STATION_UI_PORT}/api/system/identity" >/dev/null; do
  if (( SECONDS >= deadline )); then
    "${compose[@]}" logs --no-color station >&2 || true
    echo 'authenticated Station API did not become ready' >&2
    exit 1
  fi
  sleep 1
done
STATION_CONTAINER_HOST_CREDENTIAL="$credential" \
STATION_CONTAINER_WORKSPACE=/workspace \
PW_BASE_URL="http://127.0.0.1:${STATION_UI_PORT}" \
npx playwright test tests/container-self-host.spec.ts tests/device-pairing-mobile.spec.ts --workers=1
unset credential

"${compose[@]}" restart station
deadline=$((SECONDS + 90))
until curl --fail --silent "http://127.0.0.1:${STATION_UI_PORT}/__station/identity" >/dev/null; do
  (( SECONDS < deadline )) || { "${compose[@]}" logs --no-color station >&2 || true; exit 1; }
  sleep 1
done
credential=$("${compose[@]}" exec -T station sh -c 'STATION_HOME=/data/station ./station environment credential show')
deadline=$((SECONDS + 90))
until curl --fail --silent \
  --header "Authorization: Bearer $credential" \
  "http://127.0.0.1:${STATION_UI_PORT}/api/system/identity" >/dev/null; do
  if (( SECONDS >= deadline )); then
    "${compose[@]}" logs --no-color station >&2 || true
    echo 'authenticated Station API did not recover after restart' >&2
    exit 1
  fi
  sleep 1
done
STATION_CONTAINER_HOST_CREDENTIAL="$credential" \
STATION_CONTAINER_WORKSPACE=/workspace \
STATION_CONTAINER_EXPECT_PERSISTED=1 \
PW_BASE_URL="http://127.0.0.1:${STATION_UI_PORT}" \
npx playwright test tests/container-self-host.spec.ts --workers=1
echo 'Container smoke passed.'
