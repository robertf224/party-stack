# Worktree dev Vite plugin

Stable named local URLs and shared local env files from `vp dev` (or `vite`) with
no command wrapper or separate Portless dependency. Portless is installed
transitively by this package.

```ts
import { worktreeDev } from "@party-stack/vite-plugin-worktree-dev";
import { defineConfig } from "vite-plus";

export default defineConfig({ plugins: [worktreeDev()] });
```

The name defaults to the Vite root's `package.json` name without its scope:
`@my-org/web` becomes `http://web.localhost:1355` in the primary checkout. Use
`name` when the stable app hostname should differ from the package name:

```ts
worktreeDev({ name: "dashboard" }); // dashboard.localhost
```

The plugin reuses an active Portless proxy, including its port, TLD, and HTTPS
mode. On a fresh setup it starts an HTTP proxy on port 1355 without sudo or
certificate trust changes. Vite tries the app's configured loopback port (or Vite's
default 5173), then the next available port if it is occupied; the plugin
registers that actual port, configures the public origin and HMR WebSocket URL,
and prints the named URL as `Worktree` and the direct localhost URL as `Local`,
with its actual port.
Routes are removed when Vite closes or restarts, and
Portless prunes routes belonging to dead processes. A hostname already owned by
another process fails without taking over that app.

For example, `server: { port: 3000 }` also makes the app available at
`http://localhost:3000` when that port is free. Other running worktrees use later
ports while retaining their own named URLs. To test OAuth with a registered
localhost callback, open the app through that localhost URL before starting
sign-in. Use `PORTLESS=0 vp dev` when auth also needs Vite's regular origin behavior.

Linked Git worktrees automatically get a single subdomain label before the app
name. A branch such as `codex/fix-ui` becomes `codex-fix-ui.web.localhost`.
Slashes and other non-DNS characters become hyphens; long labels are shortened
with a hash suffix. Detached HEAD uses `wt-<10 hex characters>`, derived from the
SHA-256 hash of the canonical absolute worktree root. This is stable across
restarts and commits, and independent of which app directory launches Vite;
moving the worktree changes the detached ID. Main checkouts and non-Git apps
keep the bare app name. The worktree label is always derived automatically,
including when `name` is overridden. Creating or switching branches changes
the branch-derived URL.

The app suffix stays fixed, so an origin allowlist can cover worktrees with
`https://*.web.localhost`. Add `https://web.localhost` separately for the main
checkout, and match the scheme and port of your proxy's printed URL. The plugin
does not modify external CORS policies.

The resolved public origin is available as `import.meta.env.WORKTREE_DEV_ORIGIN`
during development, including in server modules. Apps can use it for auth base
URLs and callback URLs rather than a shared `.env` value tied to another checkout.

During development, missing `.env` and `.env.local` files are automatically linked to the same
app path in the primary Git checkout, following Streamline Studio's dev setup.
The mapping is one file to the same file at the same relative app path:

| Primary checkout      | Worktree              |
| --------------------- | --------------------- |
| `apps/web/.env`       | `apps/web/.env`       |
| `apps/web/.env.local` | `apps/web/.env.local` |

This happens before Vite and framework config hooks load env files. Vite's
`envDir` is respected, and linking still works with `PORTLESS=0`.
Edits to the shared file are visible through the symlink; restart dev servers
after changing env values.

Each file is handled independently: an existing `.env` does not prevent linking
a missing `.env.local`, or vice versa. Existing local files and symlinks
(including dangling symlinks) are preserved. Vite's normal `.env.local` precedence
over `.env` is retained.
The target must be gitignored. An absent primary-checkout file is skipped, so apps that
do not require local env files still work. Builds, previews, tests, and Vite+
task metadata discovery do not link files. No linking occurs with `envDir: false`.
Process-injected env values retain Vite's normal precedence.

```ts
worktreeDev({ env: false }); // Disable env provisioning.
```

The plugin links files; Vite handles combining their values. There are no custom
source paths or file lists. Keep credentials in the ignored shared files; only
env names matching Vite's configured `envPrefix`
(normally `VITE_`) are exposed to the browser.

Set `PORTLESS=0` to use regular Vite development. Builds, preview, and Vite+ task
metadata discovery do not start a proxy. Middleware mode is unsupported. HTTPS
belongs on the Portless proxy; the Vite backend must use HTTP. An existing
`PORTLESS_URL`/`PORT` environment from the Portless CLI is honored without
registering a duplicate route. `PORTLESS_STATE_DIR` overrides the shared state
directory for isolated environments. `PORTLESS_PORT` chooses an unprivileged
startup port instead of 1355 when no proxy is running. Requires Vite 8.3+ (or the
workspace's Vite+).
