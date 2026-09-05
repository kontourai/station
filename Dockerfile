# Station's production container deliberately uses the same lifecycle supervisor as
# `station service run`: one UI origin proxies the API, streams, and WebSockets.
FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
# g++/make/python3 exist solely to compile node-pty, the one source-built
# native addon on Linux (#1245). Once packaging/node-pty-prebuilds/manifest.json
# pins attested linux-x64/linux-arm64 artifacts, the lifecycle stages those
# prebuilds instead of compiling and this toolchain layer can be dropped.
RUN apt-get update \
  && apt-get install --no-install-recommends -y g++ make python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk/package.json packages/sdk/
COPY packages/sdk/package-lock.json packages/sdk/
COPY packages/basis-pane/package.json packages/basis-pane/
COPY packages/board-pane/package.json packages/board-pane/
COPY packages/shared/package.json packages/shared/
COPY packages/shared/package-lock.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/connect/package.json packages/connect/
COPY examples/builder-delivery-viewer/package.json examples/builder-delivery-viewer/
COPY examples/fieldwork-review/package.json examples/fieldwork-review/
COPY config/dependency-lifecycle-allowlist.json config/plugin-scaffold-dependencies.json config/
COPY schemas/dependency-lifecycle-allowlist.schema.json schemas/
COPY patches ./patches
# The node-pty prebuild channel (#1245): the lifecycle's consistency check and
# staging read this whether or not the manifest pins artifacts.
COPY packaging/node-pty-prebuilds packaging/node-pty-prebuilds
COPY scripts/node-runtime-contract.mjs scripts/dependency-lifecycle.mjs scripts/
COPY scripts/lib/dependency-lifecycle-policy.mjs scripts/lib/workspace-dependency-satisfaction.mjs scripts/lib/dependency-install-retirement.mjs scripts/lib/
RUN npm run dependencies:ci

FROM dependencies AS build
ARG STATION_RELEASE_SHA
ARG STATION_RELEASE_REF
ARG STATION_RELEASE_CREATED_AT
ARG STATION_IMAGE_REPOSITORY=kontourai/station
WORKDIR /app
COPY station esbuild.config.mjs vite.config.ts tsconfig.json tsconfig.tests.json ./
# vite.config.ts imports src-desktop/tauri.conf.json at config-load time.
COPY src-desktop/tauri.conf.json src-desktop/
COPY scripts ./scripts
COPY packages ./packages
COPY src-server ./src-server
COPY src-shared ./src-shared
COPY src-ui ./src-ui
COPY schemas ./schemas
# Bundled starter registry: examples/registry/default.json is the manifest
# Station falls back to when no registryUrl is configured.
COPY examples ./examples
RUN node scripts/lib/container-release-metadata.mjs \
  --tag="$STATION_RELEASE_REF" \
  --sha="$STATION_RELEASE_SHA" \
  --created-at="$STATION_RELEASE_CREATED_AT" \
  --repository="$STATION_IMAGE_REPOSITORY" \
  --station-manifest=.station-release.json >/dev/null
RUN STATION_UI_BUNDLE_BUDGET=observe ./station build --instance=container --base=/tmp/station-build-home --port=3141 --ui-port=3000

FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends -y tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/.station /data/station /workspace \
  && chown -R node:node /app/.station /data /workspace \
  && chmod 700 /data/station
# Keep the runtime dependency layer tied only to the manifest-driven install.
# The build stage inherits it, but source changes invalidate that stage and
# would otherwise force an expensive recursive copy into the runtime image.
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/station /app/.station-release.json ./
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/src-server ./src-server
COPY --from=build --chown=node:node /app/src-shared ./src-shared
COPY --from=build --chown=node:node /app/schemas ./schemas
COPY --from=build --chown=node:node /app/examples ./examples
COPY --from=build --chown=node:node /app/dist-server-container ./dist-server-container
COPY --from=build --chown=node:node /app/dist-ui-container ./dist-ui-container
ARG STATION_RELEASE_SHA
ENV NODE_ENV=production \
  STATION_HOME=/data/station \
  STATION_IMAGE_SHA=$STATION_RELEASE_SHA
EXPOSE 3000 3141 3142 3143 3144
VOLUME ["/data/station"]
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/__station/identity').then(async(response)=>{if(!response.ok)throw new Error(String(response.status));const identity=await response.json();if(identity.sha!==process.env.STATION_IMAGE_SHA)throw new Error('image identity mismatch')})" || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["./station", "service", "run", "--instance=container", "--base=/data/station", "--port=3141", "--ui-port=3000", "--host=0.0.0.0"]
