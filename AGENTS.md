# AGENTS instructions

## This repository is public

party-stack is open source. Everything committed or posted here is public: code, comments, tests, fixtures, changesets, commit messages, PR titles and descriptions, and review comments.

- Keep internal and customer details out. Don't name a customer's or a private Ontology's object types, action types, properties, rows or counts, and don't include their URLs, hostnames, RIDs, IDs, tokens, screenshots or logs.
- Describe a problem by its shape instead: "a delete action whose target is an object-list parameter", "a string parameter written into a geopoint property".
- Apps that use party-stack, such as Streamline, can be named, and their issues described in general terms.
- Use made-up names in tests and examples (`Task`, `Facility`, `Employee`), not names copied from a real Ontology.
- If something internal was already pushed, tell the user. Rewriting history doesn't remove it from GitHub's PR timeline or from forks.

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
- Property tests use Effect `Arbitrary`, not fast-check. Use `@effect/vitest`'s `it.effect.prop` with test services or `it.live.prop` for real IO/time. Keep Effect test packages on `@party-stack/build-config/effect` so Vitest shares Vite+'s runner. Use `Arbitrary.checkEffect` inside an existing shared fixture; convert assertion defects into typed failures there so shrinking can run. Acquire fresh state per generated scenario, retain independent oracles, and preserve replay tokens for failures.
- Pair each safety property ("nothing wrong is ever observed") with a progress property under continuous interference ("every read, load or action still completes while polls, invalidations, edits and slow responses keep arriving"). Model latency in clock time, not only as holds released all at once, and check progress before the interference stops: a convergence check after everything is released cannot detect starvation or livelock.
- Mutation-check a new invariant: break the code it guards (by hand, temporarily) and confirm the property fails, then restore it.
- Read a package's own `AGENTS.md` before changing it, when one exists (for example `packages/ontology-replica/AGENTS.md` for the replica's scheduling oracle).

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

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

Official Effect skills are vendored under `.agents/skills`. Use `effect-ts` for
setup and local guidance; use `effect-v3-to-v4` only for an actual v3-to-v4 migration.
For this repo, keep Effect-specific build/lint presets in the separate
`@party-stack/build-config/effect` export. Application rows need no mandatory
Effect Schema; schema validation at infrastructure/storage boundaries is separate.
