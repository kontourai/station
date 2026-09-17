# Station's optional contributor command Interface. The npm scripts and the
# verification coordinator remain the canonical implementation and receipt
# authorities; these recipes only forward to them.
set windows-shell := ["cmd.exe", "/D", "/E:ON", "/V:OFF", "/C"]

# List Station contributor commands.
default:
    @just --list

# Install the lockfile-pinned Node dependency tree.
[unix]
setup:
    npm run dependencies:ci

# Install the lockfile-pinned Node dependency tree.
[windows]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
setup:
    @call npm run dependencies:ci
    @exit /b %ERRORLEVEL%

# Report Station readiness through the repository CLI.
[unix]
[positional-arguments]
doctor *args:
    ./station doctor "$@"

# Report Station readiness through the repository CLI.
[windows]
[positional-arguments]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
doctor *args:
    @call npx tsx scripts/station-cli.ts doctor %*
    @exit /b %ERRORLEVEL%

# Start a local Station instance.
[unix]
[positional-arguments]
dev *args:
    ./station start "$@"

# Start a local Station instance.
[windows]
[positional-arguments]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
dev *args:
    @call npx tsx scripts/station-cli.ts start %*
    @exit /b %ERRORLEVEL%

# Run Station's canonical static verification lane.
[unix]
check:
    npm run verify:static

# Run Station's canonical static verification lane.
[windows]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
check:
    @call npm run verify:static
    @exit /b %ERRORLEVEL%

# Select changed tests or run explicit focused test files.
[unix]
[positional-arguments]
test *args:
    if [ "$#" -eq 0 ]; then npm run test:changed -- --base=origin/main; else npm run test:focused -- "$@"; fi

# Select changed tests or run explicit focused test files.
[windows]
[positional-arguments]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
test *args:
    @if not "%~1"=="" goto focused
    @call npm run test:changed -- "--base=origin/main"
    @exit /b %ERRORLEVEL%
    :focused
    @call npm run test:focused -- %*
    @exit /b %ERRORLEVEL%

# Run the sole completion lane without adding a second receipt protocol.
[unix]
full:
    npm run full:regression

# Run the sole completion lane without adding a second receipt protocol.
[windows]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
full:
    @call npm run full:regression
    @exit /b %ERRORLEVEL%

# Launch the native desktop development shell.
[unix]
desktop:
    npm run dev:desktop

# Launch the native desktop development shell.
[windows]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
desktop:
    @call npm run dev:desktop
    @exit /b %ERRORLEVEL%

# Build the Android debug APK through Station's existing native build command.
[unix]
android:
    npm run build:android

# Build the Android debug APK through Station's existing native build command.
[windows]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
android:
    @call npm run build:android
    @exit /b %ERRORLEVEL%

# Run the existing release-static preflight; it does not publish a release.
[unix]
release-check:
    npm run release:static

# Run the existing release-static preflight; it does not publish a release.
[windows]
[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]
release-check:
    @call npm run release:static
    @exit /b %ERRORLEVEL%
