---
"@party-stack/vite-plugin-worktree-dev": minor
"@party-stack/tanstack-start-build-config": minor
---

Add a worktree dev Vite plugin with transitive Portless installation, package-derived
hostnames, automatic branch or stable directory-hash prefixes for linked worktrees, an optional app name override, proxy startup, HMR, and route cleanup.
Enable named local URLs by default in the TanStack Start build config.
Preserve the configured Vite port for direct localhost access, falling back to an
available port when occupied while registering the actual port with Portless.
Print the named URL as `Worktree` and the direct localhost URL as `Local`.

Link missing, gitignored `.env` and `.env.local` files independently from the matching app in the primary
checkout before development env loading. Preserve existing files and symlinks,
support disabling env linking, and leave builds, previews,
tests, and task metadata discovery untouched.

Expose the resolved development origin for app authentication and callback URLs.
Use it as Issue Tracker's development auth base URL so worktree logins pass origin validation.
