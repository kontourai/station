<!-- station:contributor-commands:start -->
# Contributor commands

This reference is generated from the paired Unix and Windows recipe metadata in `justfile`. It is the exact convenience-command interface; the invoked npm scripts and verification coordinator remain the canonical implementation and completion-receipt authorities.

## `setup`

Install the lockfile-pinned Node dependency tree.

Run: `just setup`

### macOS and Linux

```sh
npm run dependencies:ci
```

### Windows Command Prompt

```bat
@call npm run dependencies:ci
@exit /b %ERRORLEVEL%
```

## `doctor`

Report Station readiness through the repository CLI.

Run: `just doctor [arguments...]`

### macOS and Linux

```sh
./station doctor "$@"
```

### Windows Command Prompt

```bat
@call npx tsx scripts/station-cli.ts doctor %*
@exit /b %ERRORLEVEL%
```

## `dev`

Start a local Station instance.

Run: `just dev [arguments...]`

### macOS and Linux

```sh
./station start "$@"
```

### Windows Command Prompt

```bat
@call npx tsx scripts/station-cli.ts start %*
@exit /b %ERRORLEVEL%
```

## `check`

Run Station's canonical static verification lane.

Run: `just check`

### macOS and Linux

```sh
npm run verify:static
```

### Windows Command Prompt

```bat
@call npm run verify:static
@exit /b %ERRORLEVEL%
```

## `test`

Select changed tests or run explicit focused test files.

Run: `just test [arguments...]`

### macOS and Linux

```sh
if [ "$#" -eq 0 ]; then npm run test:changed -- --base=origin/main; else npm run test:focused -- "$@"; fi
```

### Windows Command Prompt

```bat
@if not "%~1"=="" goto focused
@call npm run test:changed -- "--base=origin/main"
@exit /b %ERRORLEVEL%
:focused
@call npm run test:focused -- %*
@exit /b %ERRORLEVEL%
```

## `full`

Run the sole completion lane without adding a second receipt protocol.

Run: `just full`

### macOS and Linux

```sh
npm run full:regression
```

### Windows Command Prompt

```bat
@call npm run full:regression
@exit /b %ERRORLEVEL%
```

## `desktop`

Launch the native desktop development shell.

Run: `just desktop`

### macOS and Linux

```sh
npm run dev:desktop
```

### Windows Command Prompt

```bat
@call npm run dev:desktop
@exit /b %ERRORLEVEL%
```

## `android`

Build the Android debug APK through Station's existing native build command.

Run: `just android`

### macOS and Linux

```sh
npm run build:android
```

### Windows Command Prompt

```bat
@call npm run build:android
@exit /b %ERRORLEVEL%
```

## `release-check`

Run the existing release-static preflight; it does not publish a release.

Run: `just release-check`

### macOS and Linux

```sh
npm run release:static
```

### Windows Command Prompt

```bat
@call npm run release:static
@exit /b %ERRORLEVEL%
```

<!-- station:contributor-commands:end -->
