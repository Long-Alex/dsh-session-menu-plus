# dsh-session-menu-plus

Three additions to the DeepSeek Harness sidebar Session list: **a Session menu on right-click**, **a read/unread mark**, and **Session deletion behind a confirmation**.

## What it does

- Right-click any Session row in the sidebar and that row's own "⋯" menu opens — no more aiming for the icon.
- `Mark as unread` / `Mark as read` (first row in the menu) flips a mark for that Session: unread rows carry the same green `done` state dot DSH uses for its own row states, in the row's leading status cell.
- The menu gains `Export as Markdown` (download icon, right after `Copy Session ID`) and `Delete session` (danger colour, trash icon, with a separator above it).
- `Export as Markdown` downloads `session-<uuid>.md` and reports `Session exported`.
- `Delete session` asks first: `Delete this session?`, the Session title, and `Cancel` / `Delete session`.
- The outcome arrives as a notice: `Session deleted` on success, or one of "still running", "no longer exists", "delete failed".
- The only reason a delete is refused is a Session with a running agent. The row you currently have open can be deleted.
- Deletion is thorough: transcript directory, projection cache, spill, workspace membership, archive flag and registry index all go, then `api-session/removed` makes the Client drop the row immediately.

## Install

```bash
dsh plugin add /path/to/dsh-session-menu-plus   # or install the directory from the Harness plugin manager
```

Restart Harness afterwards — Client modules are loaded as a bundle.

## Export format

One row, one output: a transcript meant to be read.

- Opens with the header block: `# <title>`, the cwd / model / preset essentials, then `---`.
- One `## Turn N · <time>` section per turn, holding only the prose blocks: `**User**`, `**Assistant**`.
- Tool calls and their results render as paired `<details>` so long output cannot bury the conversation; arguments and results are each clipped to 4000 characters.
- A call with no recorded result says `_No result was recorded._` instead of inventing one.
- Fences pick a backtick run that the content does not already contain, so a fenced block can never close early.

Preconditions:

- Before reading, the live instance is flushed with `sessions.flush`, so even a running Session exports everything committed up to that moment.
- Reading goes through `sessionPersistence.open(id, 'read')` — the same bytes the backend stores; the projection cache is not used.
- The text is handed to the browser as `text/markdown`.

## How it is built

- **The export row (Client)**: a plain built-in `MenuItemButton` that closes the menu and requests the export. No submenu: the Session menu opens with `closeOnPointerLeave`, so a card floating beside it takes the parent away as soon as the pointer moves in, and an absolutely positioned card inside the menu gets clipped by the menu surface.
- **The delete row (Client)**: `sidebar.workspaces.session.menu.item` injects a `MenuItemButton` (danger colour, trash icon, separator). Selecting it opens a `Modal`; confirming sends `POST /session-menu-plus/delete`; both outcomes use the shared `Toast`. No bespoke dialog, no edited built-in components.
- **The unread mark (Client)**: two seats, no new widgets. The toggle is a `MenuItemButton` in the menu list; the dot is one component in `sidebar.session.row.leading` — the 16px cell DSH already gives its own row-state marks (the schedule plugin's clock mark sits there too) — and it *is* the shared `StateDot` primitive at `state="done"`, so colour and geometry are the platform's, not ours. The cell only offers itself while the row's primary state is idle, so the dot never competes with a running or pending indicator. Marks live in `localStorage` under `dsh-session-menu-plus:unread` and follow the `storage` event, so two windows agree; nothing is written to the Host.
- **Right-click**: the `contextmenu` gesture is forwarded to that row's own "⋯" trigger, so the menu, focus handling, outside dismissal and shortcuts stay the built-in ones.
- **Host — the delete sequence, entirely through Host services, never by scanning directories**:
  1. Refuse only when `agents.get(id).status === 'running'`.
  2. `readHeader`: live instance → `sessionQuery.readSession` → `sessionPersistence.list`.
  3. For a live instance, `sessions.flush()` then `detachEntered`, so nothing keeps appending to files that are about to disappear.
  4. `sessionProjectionCache.delete(id)`.
  5. `workspaceRegistry.unarchiveSession(id)` plus `detachSession(id)` on every workspace.
  6. `sessionPersistence.locate(header)` gives the transcript path; delete the whole directory when only backend files remain (transcript plus `session.lock`), otherwise just the transcript.
  7. Remove the matching `spillStore` directory.
  8. Clear the registry's in-memory index (`headers`/`sessionPaths`/`missingSessionPaths`/`invalidSessionPaths`) so a stale list cannot re-materialise the row.
  9. `emit('api-session/removed')`; the Client refreshes its Session list.
- **Host services are all taken through `ctx.get()`**; a missing one degrades to a skipped step rather than a hard dependency. `webServer` and `connection` come from `ctx.inject`.

## Known limits

- A Session with a running agent is refused; everything else, including the row you have open, is deletable.
- The read/unread mark is this plugin's own and per Client: it is not the platform's `completionUnread` chip (that one is runtime-only and has no setter), it does not sync across machines, and it is cleared by hand rather than by opening the Session.
- Deleting the open Session leaves the conversation pane on the empty/onboarding state — the transcript directory and projection cache are already gone.
- Deletion does not prune `sessionIds` / `archivedSessionIds` / `pinnedSessionIds` from `workspace.json`: the platform exposes no removal API for them. A leftover entry is not rendered and has no effect.

## Verification

`verification/` holds screenshots from real runs: the right-click menu, the confirmation, the success notice with the row gone, and the refusal when deleting the row that is open.
`tests/delete-route.test.js` covers the delete route's success / in-use / missing / malformed branches:

```bash
node --test tests/
```
