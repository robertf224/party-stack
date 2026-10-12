# AGENTS instructions

## Development environment instructions

- Run `vp install --filter <project_name>` to add a project to your workspace. Without the global Vite+ CLI, use `pnpm install --filter <project_name>`.
- Run `vp run -t <project_name>#build`, then `vp run <project_name>#dev` for app development. Library watch builds can be run with `vp pack --watch` from the library directory.

## Testing instructions

- Find the CI plan in the .github/workflows folder.
- Run `vp run <project_name>#test` to build prerequisites and run a package's tests.
- Run `vp run <project_name>#check` for formatting, lint, and type checks.
- Fix test or type errors until the suite is green.
- After moving files or changing imports, run `vp run <project_name>#build` to verify checks and published outputs.
- Add or update tests for code changes when appropriate.

## PR instructions

- Title format: [<project_name>] <Title>
- Always run `vp run ci` before committing.

## Toolchain

- Vite+ owns workspace scheduling and caching through `vp run`.
- Shared lint, format, and staged-file settings live in the root `vite.config.ts`; library and app task defaults live in `@party-stack/build-config`, with package overrides and framework plugins in `vite.config.ts`.
- Package `check` tasks wait for upstream builds. Package `build` tasks wait for their checks and upstream builds; tests wait for the package build.
- Library builds use `vp pack` with unbundled ESM and declarations in `lib`; app builds use `vp build`.
- Use `pnpm exec vp` instead of `vp` when the global CLI is unavailable.

- Icon Lab embedding generation is manual. Do not run `icons:embed` or `icons:prepare` during routine checks, builds, tests, or dev startup. Users prepare its data explicitly before using the app.

- `@party-stack/build-config` builds its TypeScript presets during installation. If its `lib` outputs are removed, bootstrap them with `pnpm exec vp -C packages/build-config pack` before running workspace tasks.
