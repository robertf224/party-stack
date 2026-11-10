# Notes

A TanStack Start app with regular notes, encrypted secure notes and saved logins,
embedded attachments, folders, pins and trash. TipTap edits Markdown. Component
fragments use generated collection descriptors and native TanStack DB includes.

```sh
pnpm exec vp run @party-stack/notes#build
pnpm exec vp run @party-stack/notes#dev
```

The app prints its local preview URL. A SharedWorker owns persistent browser data
and pending actions; each tab has an in-memory replica. The app uses one workspace for the device.

The server uses SQLite and filesystem bytes under `temp/notes` and stores encryption
keys in the native OS keyring. The local demo binds requests to that device workspace; add authentication before hosting it publicly.

Secure fields contain encrypted handles. Reveal decrypts into component state;
hiding or leaving the editor drops that state. The app-only `sealSecret` query
function is an experiment for encrypting an edit before enqueueing its action.
It is not a shared API or the final outbox encryption design.

Useful entry points:

- `src/notes/NotesViews.tsx`: persistent workspace, pane layout and folder inventory query.
- `src/notes/FolderNotes.tsx`: selected-folder root query and relation composition.
- `src/notes/NoteList.tsx`: list fragment, independent pagination and keyboard navigation.
- `src/notes/FolderLink.tsx`, `FolderTitle.tsx`: sidebar and heading fragments.
- `src/notes/NotePreview.tsx` and `NoteEditor.tsx`: component-local fragments composed by their parents.
- `src/notes/downloadFolder.ts`: the named folder download graph, including attachment bytes.
- `src/notes/NotesProvider.tsx`: tab lifecycle, suspense and demand retention.
- `src/notes/ontology.worker.ts`: persistent replicas and upstream client.
- `src/server/ontology.ts`: owned backend, encryption and demo seed data.
- `src/ontology/ontology.ts`: objects, actions and policy.

DB reads use Suspense boundaries. The shell stays mounted across note routes, and
query demand is retained for 30 seconds after the last reader leaves. A completed,
held full-collection query also covers local filters and windows; redundant
filtered demands do not replace its live delivery subscription. Development
query attribution is enabled through the devtools Vite plugin.

The selected-folder query composes a folder fragment, which includes the list via
`objects.Notebook.links.notes(folder)`. The list owns active/deleted filters,
pin-first ordering, search and preview fragments. It reads its native included
collection with `useListFragment`, which then re-roots the same selection over its
original sources with the concrete folder binding. Windows start at 50 notes;
Load more widens that reader's native infinite query without changing the parent.
Counts show `50+` while another page exists. The included page stays visible during
initial root acquisition. The fragment adapter retains query metadata, not another
row cache. Current grouped includes can still acquire more source data than their
output limit; this is not yet bounded upstream pagination.
The header controls stay mounted and reflect folder selection immediately. The list
projects its live count into that header with a portal; opening a menu while the
folder loads does not lose its state. React prepares the next live
query in a deferred render; the previous list is hidden and inert until it is
replaced. This avoids both stale folder contents and the 300ms fallback throttle
observed with a newly keyed Suspense boundary. No row cache or direct collection
lookup is used for rendering.

Keyboard navigation keeps focus in the note list, including for empty notes.
Press Right Arrow to enter the selected editor. New Note requests editor focus
explicitly so it is ready for typing immediately.

Regular notes use the first line as their title. Type `/` for code, quotes, lists,
formatting or attachments. Highlighted code supports TypeScript, Rust, HTML and
JSON. Secure notes and logins keep a separate public label.

The sidebar shows the default Notes folder, custom folders and Recently deleted. Folder and note
selection use routes (`/folders/:folderId`, `/folders/:folderId/:noteId`), and
deleting a note returns to its folder. Pins appear at the top of each folder.
Use the folder header's menu or right-click a sidebar folder to edit its name and
color or delete it. Deleting a folder moves its notes to Recently deleted in one
action; restoring them places them in Notes. The default Notes folder is permanent.
Date groups use local calendar days: Today, Yesterday, Previous 7 Days, Previous
30 Days, then months and years. Labels update at local midnight.

The Notes ontology includes a Preferences object for saved panel widths. Resizing
queues setPanelWidths in the same outbox as note edits. Tabs keep their sidebar
open/closed state in memory; ⌘J (Ctrl+J) toggles the folders sidebar. Each folder
has a download button in its header. Yellow means downloading (click to cancel),
green means available offline (click to remove). The sidebar shows a green
indicator only for completed downloads. Status uses ordinary live queries and a
join to the typed pin collection. The retired whole-device Settings pin is cleared
on startup; independent named folder downloads remain intact.

On phones, Search opens a dialog and the + menu inserts editor blocks. Navigation
between the list and a note uses the router's native view transitions, respecting
reduced motion.

To run the browser UI regression check against the preview:

```sh
pnpm --filter @party-stack/notes exec node e2e/smoke.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/lifecycle.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/creation.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/navigation.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/list-navigation.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/preferences.mjs <preview-url> http://127.0.0.1:5173/api/ontology/rpc
pnpm --filter @party-stack/notes exec node e2e/mobile.mjs <preview-url> http://127.0.0.1:5173/api/ontology/rpc
pnpm --filter @party-stack/notes exec node e2e/responsive.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/startup.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/offline-startup.mjs <preview-url> <local-tls-key> <local-tls-cert>
pnpm --filter @party-stack/notes exec node e2e/folders.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/folder-loading.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/folder-navigation.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/fragments.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/delivery.mjs <preview-url>
pnpm --filter @party-stack/notes exec node e2e/offline.mjs <preview-url> http://127.0.0.1:5173/api/ontology/rpc
pnpm --filter @party-stack/notes exec node e2e/startup-profile.mjs <preview-url>
```

The focused delivery check alternates edits between two tabs, then deletes a note
offline and checks optimistic removal and folder navigation. The lifecycle check exercises backgrounding, reduced motion, sidebar transitions,
checklist focus and fractional resize persistence. The creation check creates and
edits a disposable note offline, then reconnects and reloads it. Navigation checks
that cached note switches do not suspend or display a previous note. The mobile
check uses touch input, checks checklist text alignment, and opens a previously
unopened note and attachment offline after enabling the folder download. Its last
argument is the local RPC URL used by the Node fixture client; the browser uses
the HTTPS preview URL. All checks write only disposable notes.
The responsive check covers header controls, folder routes and dialogs, offline
downloads, and deleting back to the folder. The startup check verifies that cold
phone loads show a single splash without exposing list skeletons.
Folder checks cover desktop context menus, phone header menus, offline edits,
deletion and restoration. The workspace owns one live folder query so closing the
sidebar does not dispose it. The startup profiler records resource/RPC timings
and object-type selections in `/tmp/party-notes-startup-profile.json`, without
note contents.
The download check verifies independent folder retention, cross-tab status, rapid
cancellation, reloads, ready-only sidebar indicators, grouped Pinned inspection
and scrolling, and unopened attachment reads offline.
The fragment check creates a 55-note folder and exercises child-owned pagination,
keyboard focus, relationship moves, folder navigation, offline optimistic creation
and delivery between two tabs in one browser context. It reports phase timings and
archives its disposable folders. Library browser tests also check that pagination
keeps query identity, avoids parent rebuilds/Suspense remounts, resets on argument
changes, and releases readers on unmount.

Keep loading boundaries close to the data they need. Closed menus do not load
folder choices; opening the Move to submenu starts that query inside its own
Suspense boundary. ViewTransition boundaries stay mounted when visibility changes,
so backgrounding a tab does not close its providers or replicas.
