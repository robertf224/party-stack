# TanStack DB patches

An Effect CLI that registers Party Stack's tested TanStack patches using pnpm's
native patch support. Run setup once; future ordinary `pnpm install` commands
apply the patches. There is no custom pnpm hook, postinstall script, runtime
import, or forked DB package.

Version `0.1.0` is **not published yet**. It targets exactly:

| Package              | Version        | Fix                                                                                                                                                                       |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tanstack/db`       | `1.0.0-rc.1.4` | Bounded exact ordered prefixes ([#2398](https://github.com/TanStack/db/issues/2398))                                                                                      |
| `@tanstack/react-db` | `1.0.0-rc.1.4` | Synchronous Suspense readiness ([#2396](https://github.com/TanStack/db/issues/2396)) and initial-load error retries ([#2397](https://github.com/TanStack/db/issues/2397)) |

The [ordered-window contract](./ordered-window.md) explains the DB patch and
its upstream proposal. Neither patch changes React itself. See the repository's
[patch inventory](../../patches/README.md) for scope and regression coverage.

## Setup after publication

From your pnpm project or workspace:

```sh
pnpm dlx @party-stack/tanstack-db-patches setup
```

The CLI knows its own version. It installs that exact version and integrity as a
pnpm `configDependency`, merges the native `patchedDependencies` paths, then runs
`pnpm install --no-frozen-lockfile` and checks the installed packages. Commit
`pnpm-workspace.yaml` and `pnpm-lock.yaml` afterward. Subsequent installs need
neither the CLI nor a `.pnpmfile.cjs`: pnpm installs config dependencies before it
needs their patch files.

To make the setup tool version explicit:

```sh
pnpm dlx @party-stack/tanstack-db-patches@0.1.0 setup
```

The CLI currently supports pnpm `10.34.6` and newer 10.x, with `10.34.6` tested.
The Effect CLI and Node platform implementation are bundled into the executable;
the package has no runtime dependencies or lifecycle scripts, as required for a
pnpm config dependency. It changes only project-local pnpm configuration.

## Commands

```sh
pnpm dlx @party-stack/tanstack-db-patches setup --core-only
pnpm dlx @party-stack/tanstack-db-patches setup --no-install
pnpm dlx @party-stack/tanstack-db-patches check
pnpm dlx @party-stack/tanstack-db-patches setup --cwd /path/to/workspace
```

- `--core-only` registers/checks core DB without requiring React DB. It leaves
  existing independently managed patches alone.
- `--no-install` writes configuration; run `pnpm install` yourself afterward.
- `check` verifies the patch paths, installed upstream versions, and patched
  distribution code. Pass the same `--core-only` selection used during setup.
- Invocations inside an app resolve its enclosing pnpm workspace root.

Unrelated settings and patch meanings are preserved. A conflicting patch for
the same exact target fails before setup overwrites it. The CLI does not upgrade
TanStack versions, enable `allowUnusedPatches`, or ignore patch failures. Install
the supported versions; another release needs separately reviewed patches.

## Use the unpublished package

Build and pack it from this repository:

```sh
pnpm exec vp run @party-stack/tanstack-db-patches#build
pnpm --dir packages/tanstack-db-patches pack --pack-destination /tmp
```

Until publication, unpack the tarball inside a consumer workspace and use local
mode. The vendored directory must remain checked in so later installs can find
the patch files:

```sh
mkdir -p vendor/tanstack-db-patches
tar -xzf /tmp/party-stack-tanstack-db-patches-0.1.0.tgz -C vendor/tanstack-db-patches --strip-components=1
node vendor/tanstack-db-patches/lib/cli.js setup --local
```

`--local` requires the package to live inside the target workspace; it rejects a
temporary `dlx` cache path. It registers those stable files directly and does not
add a config dependency. This repository uses the same package's patch files.
For a local-mode install, use `check --local` from that same package.

`pnpm add --config /path/to/package.tgz` is not supported by pnpm: config
dependencies require registry metadata and integrity. Local mode avoids that
bootstrap requirement. Once published, use the normal one-command setup.

## Verification

```sh
pnpm exec vp run @party-stack/tanstack-db-patches#test
pnpm exec vp run @party-stack/tanstack-db-patches#verify-distribution
```

The opt-in distribution test packs the standalone executable and serves it from
a disposable loopback npm registry. It tests normal `dlx setup/check`, core-only
and vendored local installs, both patches' source/distribution changes, one
shared DB identity, repeated setup, unrelated patches, conflict refusal and a
clean frozen-lockfile reinstall. No package is published externally.

See pnpm's [config dependency](https://pnpm.io/10.x/config-dependencies) and
[patch](https://pnpm.io/10.x/cli/patch) documentation.
