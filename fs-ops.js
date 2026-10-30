/**
 * Host half of the file context menu: the six workspace mutations the Client's
 * file and directory rows ask for, plus the locator behind "View changes",
 * mounted on the same browser carrier and trust fence as the Session routes in
 * `index.js`.
 *
 * Every path on the wire is relative to the Session's workspace and confined
 * to it twice: lexically (separators, `.`/`..` and absolute spellings are
 * refused before the join) and physically (the real path of every entry a call
 * touches, and of the directory a new entry lands in, must stay under the
 * workspace root). Rename and remove address the row the menu names, so a
 * symlink is moved or unlinked as itself and its target is never reached;
 * everything that reads through an entry — a paste source, a new entry's
 * parent directory — must resolve inside the workspace.
 *
 * The terminal launcher is the one native call: an argv array plus a working
 * directory, never shell text. The change locator reads only what the shipped
 * `workspaceChanges` service already recorded — it never diffs or runs git.
 *
 * Refusals are typed and reach the Client as `{ ok: false, code }`, where
 * `code` is one of `not-found`, `exists`, `invalid-name`, `outside-workspace`,
 * `busy`, `invalid` (the request's own fields) or `failed` (an I/O error).
 * @module dsh-session-menu-plus/fs-ops
 */

import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Create one empty file inside the directory `path`. */
const CREATE_ROUTE = '/session-menu-plus/fs/create'

/** Create one directory inside the directory `path`. */
const MKDIR_ROUTE = '/session-menu-plus/fs/mkdir'

/** Rename one entry in place. */
const RENAME_ROUTE = '/session-menu-plus/fs/rename'

/** Copy or move one entry into the directory `path`. */
const PASTE_ROUTE = '/session-menu-plus/fs/paste'

/** Remove one entry, recursively. */
const REMOVE_ROUTE = '/session-menu-plus/fs/remove'

/** Open the Host's terminal at the directory `path`. */
const TERMINAL_ROUTE = '/session-menu-plus/open-terminal'

/**
 * Locate the change summary a file was listed in, for the Client's
 * `changes-review` resource: the newest turn whose summary carries it.
 *
 * Evidence for the Host face this reads (DSH 0.2.2-alpha.2 source checkout):
 * `packages/deliverables/workspace-changes/src/index.ts:117-120` provides
 * `workspaceChanges` with `summary(sessionId, seq)`, declared at
 * `.../src/types.ts:86` and announced by the `workspace/changes` event at
 * `.../src/types.ts:106`. The service is read through `ctx.get` because a
 * profile that does not mount the plugin publishes nothing.
 */
const CHANGES_ROUTE = '/session-menu-plus/changes/locate'

/** A stored Session identity; anything else never reaches the workspace. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The largest name the shared name rule admits, in UTF-8 bytes. */
const NAME_BYTES = 255

/** The byte a filename can never carry. */
const NUL = String.fromCharCode(0)

/**
 * Platform terminal launches, as argv builders: the working directory is one
 * argument and never shell text. The first one present on the machine wins.
 */
const TERMINALS = {
  darwin: [{ command: 'open', args: (directory) => ['-a', 'Terminal', directory] }],
  win32: [{ command: 'wt.exe', args: (directory) => ['-d', directory] }],
  linux: [
    { command: 'x-terminal-emulator', args: (directory) => ['--working-directory', directory] },
    { command: 'gnome-terminal', args: (directory) => [`--working-directory=${directory}`] },
    { command: 'konsole', args: (directory) => ['--workdir', directory] },
    { command: 'xfce4-terminal', args: (directory) => [`--working-directory=${directory}`] },
  ],
}

/** One typed refusal, answered to the Client as its `code`. */
class Refusal extends Error {
  /**
   * @param code - the wire code the Client maps to its own notice.
   */
  constructor(code) {
    super(code)
    this.code = code
  }
}

/**
 * Refuse the current call.
 * @param code - wire code to answer with.
 * @returns never.
 */
function refuse(code) {
  throw new Refusal(code)
}

/**
 * Turn one handler's typed refusal into the Client's reply and let every other
 * failure reach the route's own 500.
 * @param handle - one workspace operation.
 * @param deps - the helpers that operation reads.
 * @returns the route handler the carrier calls.
 */
function answer(handle, deps) {
  return async (host, sessionId, body) => {
    try {
      return await handle(host, deps, sessionId, body)
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, code: error.code }
      throw error
    }
  }
}

/**
 * Write one JSON reply.
 * @param response - the browser response to complete.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function respond(response, status, value) {
  if (response.headersSent === true) {
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

/**
 * Read a small request body as UTF-8 text.
 * @param request - the incoming browser request.
 * @returns the decoded body.
 */
async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Borrow one optional Host service.
 * @param ctx - Host context.
 * @param name - service name.
 * @returns the service, or undefined when this Host does not publish it.
 */
function service(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Mount one POST route with the Host's browser-trust fence and Session identity
 * check, the same way `index.js` does for its own routes.
 * @param hostCtx - Host context carrying the web server and its fence.
 * @param path - exact route path.
 * @param handle - answers one validated Session identity and its whole body.
 */
function mount(hostCtx, path, handle) {
  hostCtx.effect(() => hostCtx.webServer.register({
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (hostCtx.connection.requestRejection(request) !== undefined) {
        respond(response, 403, { ok: false, code: 'forbidden' })
        return
      }
      if (request.method !== 'POST') {
        respond(response, 405, { ok: false, code: 'method' })
        return
      }
      try {
        const body = JSON.parse(await readBody(request))
        const sessionId = body?.sessionId
        if (typeof sessionId !== 'string' || SESSION_ID.test(sessionId) === false) {
          respond(response, 400, { ok: false, code: 'invalid' })
          return
        }
        respond(response, 200, await handle(hostCtx, sessionId, body))
      } catch (error) {
        hostCtx.logger?.warn?.(`session-menu-plus: ${path} failed: ${String(error)}`)
        respond(response, 500, { ok: false, code: 'failed' })
      }
    },
  }), `dsh-session-menu-plus: ${path}`)
}

/**
 * Resolve one Session's workspace root as one physical directory: the header's
 * own `cwd`, else the deployment's workspace root.
 * @param host - Host context.
 * @param readHeader - the Session header reader borrowed from `index.js`.
 * @param sessionId - Session whose menu was used.
 * @returns the real path everything below is confined to.
 */
async function workspaceOf(host, readHeader, sessionId) {
  const header = await readHeader(host, sessionId)
  if (header === undefined) refuse('not-found')
  const declared = typeof header.cwd === 'string' && header.cwd.length > 0
    ? header.cwd
    : service(host, 'sandboxPolicy')?.workspaceRoot
  if (typeof declared !== 'string' || isAbsolute(declared) === false) refuse('not-found')
  const root = await realpath(declared).catch(() => undefined)
  if (root === undefined) refuse('not-found')
  return root
}

/**
 * Split one wire path into segments, refusing anything that is not a plain
 * workspace-relative path.
 * @param value - `path` or `source` as the Client sent it.
 * @returns the segments below the workspace root; empty for the root itself.
 */
function segmentsOf(value) {
  if (typeof value !== 'string') refuse('invalid')
  if (value.includes(NUL)) refuse('outside-workspace')
  const slashed = value.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) refuse('outside-workspace')
  const parts = slashed.split('/').filter((part) => part.length > 0)
  if (parts.some((part) => part === '.' || part === '..')) refuse('outside-workspace')
  return parts
}

/**
 * Join validated segments under the workspace root.
 * @param root - the Session's real workspace root.
 * @param parts - segments from {@link segmentsOf}.
 * @returns the absolute target, proven to stay under `root`.
 */
function joinInside(root, parts) {
  const target = resolve(root, ...parts)
  if (target !== root && target.startsWith(root + sep) === false) refuse('outside-workspace')
  return target
}

/**
 * Resolve one existing entry to its real path, refusing an escape.
 * @param root - the Session's real workspace root.
 * @param target - absolute path to resolve.
 * @returns the real path, or undefined when nothing is there.
 */
async function realInside(root, target) {
  const real = await realpath(target).catch(() => undefined)
  if (real === undefined) return undefined
  if (real !== root && real.startsWith(root + sep) === false) refuse('outside-workspace')
  return real
}

/**
 * Resolve the directory a new entry lands in; it must exist inside the
 * workspace.
 * @param root - the Session's real workspace root.
 * @param value - the menu's `path`, relative to the workspace.
 * @returns the directory's real path.
 */
async function directoryInside(root, value) {
  const real = await realInside(root, joinInside(root, segmentsOf(value)))
  if (real === undefined) refuse('not-found')
  const info = await stat(real).catch(() => undefined)
  if (info?.isDirectory() !== true) refuse('not-found')
  return real
}

/**
 * Resolve one existing entry as the row the menu names: a symlink is the entry
 * itself, so its parent directory is what must stay inside the workspace.
 * @param root - the Session's real workspace root.
 * @param value - the menu's `path`, relative to the workspace.
 * @returns the absolute entry and its `lstat` facts; the root is never an entry.
 */
async function entryInside(root, value) {
  const target = joinInside(root, segmentsOf(value))
  if (target === root) refuse('busy')
  const info = await lstat(target).catch(() => undefined)
  if (info === undefined) refuse('not-found')
  const parent = await realpath(dirname(target)).catch(() => undefined)
  if (parent === undefined) refuse('not-found')
  if (parent !== root && parent.startsWith(root + sep) === false) refuse('outside-workspace')
  return { target, info }
}

/**
 * Resolve one entry whose content is read through (a paste source): a symlink
 * must land inside the workspace.
 * @param root - the Session's real workspace root.
 * @param value - the menu's `source`, relative to the workspace.
 * @returns the absolute entry and its followed facts.
 */
async function readInside(root, value) {
  const { target, info } = await entryInside(root, value)
  if (info.isSymbolicLink() === false) return { target, info }
  const real = await realInside(root, target)
  if (real === undefined) refuse('not-found')
  const followed = await stat(real).catch(() => undefined)
  if (followed === undefined) refuse('not-found')
  return { target, info: followed }
}

/**
 * Apply the shared name rule: one path segment, no separators or NUL, not `.`
 * or `..`, non-empty, at most 255 UTF-8 bytes.
 * @param value - the Client's proposed name.
 * @returns the name unchanged.
 */
function nameOf(value) {
  if (typeof value !== 'string') refuse('invalid')
  if (value.length === 0 || value === '.' || value === '..') refuse('invalid-name')
  if (value.includes('/') || value.includes('\\') || value.includes(NUL)) refuse('invalid-name')
  if (Buffer.byteLength(value, 'utf8') > NAME_BYTES) refuse('invalid-name')
  return value
}

/**
 * Report one absolute path as the Client's workspace-relative spelling.
 * @param root - the Session's real workspace root.
 * @param target - absolute path inside it.
 * @returns the `/`-joined relative path.
 */
function workspacePath(root, target) {
  return relative(root, target).split(sep).join('/')
}

/**
 * Read the entry at one path without following it.
 * @param target - absolute path.
 * @returns the `lstat` facts, or undefined when nothing is there.
 */
function present(target) {
  return lstat(target).catch(() => undefined)
}

/**
 * Create one empty file.
 * @param host - Host context.
 * @param deps - the wiring's borrowed helpers.
 * @param sessionId - Session whose menu was used.
 * @param body - `{ path, name }`.
 * @returns the new file's workspace-relative path.
 */
async function createEntry(host, deps, sessionId, body) {
  const root = await workspaceOf(host, deps.readHeader, sessionId)
  const directory = await directoryInside(root, body.path)
  const target = join(directory, nameOf(body.name))
  if (await present(target) !== undefined) refuse('exists')
  try {
    await writeFile(target, '', { flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') refuse('exists')
    throw error
  }
  return { ok: true, path: workspacePath(root, target) }
}

/**
 * Create one directory.
 * @param host - Host context.
 * @param deps - the wiring's borrowed helpers.
 * @param sessionId - Session whose menu was used.
 * @param body - `{ path, name }`.
 * @returns the new directory's workspace-relative path.
 */
async function makeDirectory(host, deps, sessionId, body) {
  const root = await workspaceOf(host, deps.readHeader, sessionId)
  const directory = await directoryInside(root, body.path)
  const target = join(directory, nameOf(body.name))
  try {
    await mkdir(target)
  } catch (error) {
    if (error?.code === 'EEXIST') refuse('exists')
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') refuse('not-found')
    throw error
  }
  return { ok: true, path: workspacePath(root, target) }
}

/**
 * Rename one entry in place, keeping a regular file's extension when the new
 * name carries none of its own.
 * @param host - Host context.
 * @param deps - the wiring's borrowed helpers.
 * @param sessionId - Session whose menu was used.
 * @param body - `{ path, name }`.
 * @returns the entry's new workspace-relative path.
 */
async function renameEntry(host, deps, sessionId, body) {
  const root = await workspaceOf(host, deps.readHeader, sessionId)
  const { target: entry, info } = await entryInside(root, body.path)
  const requested = nameOf(body.name)
  // A symlink row keeps the extension of what it stands for; a dangling link
  // has none to keep, and a directory never gains one.
  const kind = info.isSymbolicLink() ? await stat(entry).catch(() => undefined) : info
  const extension = kind?.isFile() === true ? extname(entry) : ''
  const name = extension.length > 0 && extname(requested).length === 0 ? `${requested}${extension}` : requested
  const target = join(dirname(entry), name)
  if (target === entry) return { ok: true, path: workspacePath(root, entry) }
  const existing = await lstat(target, { bigint: true }).catch(() => undefined)
  if (existing !== undefined) {
    // The same entry under another spelling — a case-only rename on a
    // case-insensitive volume — is the rename, not an occupied destination.
    const own = await lstat(entry, { bigint: true })
    if (existing.dev !== own.dev || existing.ino !== own.ino) refuse('exists')
  }
  try {
    await rename(entry, target)
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') refuse('exists')
    throw error
  }
  return { ok: true, path: workspacePath(root, target) }
}

/**
 * Copy or move one entry into a directory.
 * @param host - Host context.
 * @param deps - the wiring's borrowed helpers.
 * @param sessionId - Session whose menu was used.
 * @param body - `{ path, mode, source }`.
 * @returns the destination's workspace-relative path.
 */
async function pasteEntry(host, deps, sessionId, body) {
  const root = await workspaceOf(host, deps.readHeader, sessionId)
  if (body.mode !== 'copy' && body.mode !== 'cut') refuse('invalid')
  const directory = await directoryInside(root, body.path)
  const source = await readInside(root, body.source)
  const target = join(directory, basename(source.target))
  // The entry itself, or a directory into its own subtree, would be a call
  // that cannot settle: refuse it instead of copying or moving into itself.
  if (target === source.target || target.startsWith(source.target + sep)) refuse('busy')
  if (await present(target) !== undefined) refuse('exists')
  if (body.mode === 'copy') {
    try {
      await cp(source.target, target, { recursive: true, force: false, errorOnExist: true, dereference: false })
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ERR_FS_CP_EEXIST') refuse('exists')
      throw error
    }
  } else {
    try {
      await rename(source.target, target)
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') refuse('exists')
      throw error
    }
  }
  return { ok: true, path: workspacePath(root, target) }
}

/**
 * Remove one entry, recursively; a symlink goes as itself.
 * @param host - Host context.
 * @param deps - the wiring's borrowed helpers.
 * @param sessionId - Session whose menu was used.
 * @param body - `{ path }`.
 * @returns the removed entry's former workspace-relative path.
 */
async function removeEntry(host, deps, sessionId, body) {
  const root = await workspaceOf(host, deps.readHeader, sessionId)
  const { target, info } = await entryInside(root, body.path)
  try {
    if (info.isSymbolicLink()) await unlink(target)
    else await rm(target, { recursive: true, force: false })
  } catch (error) {
    if (error?.code === 'ENOENT') refuse('not-found')
    throw error
  }
  return { ok: true, path: workspacePath(root, target) }
}

/**
 * Hand one directory to the Host's terminal: argv only, no shell.
 * @param launcher - one platform launcher.
 * @param directory - the working directory to pass as its own argument.
 * @returns true once the process started, false when the launcher is absent.
 */
function startTerminal(launcher, directory) {
  return new Promise((done) => {
    const child = spawn(launcher.command, launcher.args(directory), {
      cwd: directory,
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', () => done(false))
    child.once('spawn', () => {
      child.unref()
      done(true)
    })
  })
}

/**
 * Open the Host's terminal at one directory, trying the platform's launchers
 * in order.
 * @param directory - absolute directory the terminal starts in.
 * @returns true when a terminal took the request.
 */
async function launchTerminal(directory) {
  for (const launcher of TERMINALS[process.platform] ?? []) {
    if (await startTerminal(launcher, directory)) return true
  }
  return false
}

/**
 * Open the Host's terminal at a workspace directory (a file names its parent).
 * @param host - Host context.
 * @param deps - the wiring's borrowed helpers.
 * @param sessionId - Session whose menu was used.
 * @param body - `{ path }`.
 * @returns the absolute directory the terminal started in.
 */
async function openTerminal(host, deps, sessionId, body) {
  const root = await workspaceOf(host, deps.readHeader, sessionId)
  const real = await realInside(root, joinInside(root, segmentsOf(body.path)))
  if (real === undefined) refuse('not-found')
  const info = await stat(real).catch(() => undefined)
  if (info === undefined) refuse('not-found')
  const directory = info.isDirectory() ? real : dirname(real)
  if (await deps.launchTerminal(directory) === false) refuse('busy')
  return { ok: true, path: directory }
}

/**
 * Report whether one listed change names the requested workspace path.
 * `path` is the durable relative spelling; `display` is compared too because
 * the older Hosts only filled that field for relative paths.
 * @param file - one listed change from a summary.
 * @param relative - the requested file, `/`-joined relative to the workspace.
 * @returns true when this listed change is that file.
 */
function sameChangesPath(file, relative) {
  if (typeof file?.path === 'string') {
    if (file.path.replaceAll('\\', '/').replace(/^\.\//, '') === relative) return true
  }
  return typeof file?.display === 'string' && file.display.replaceAll('\\', '/') === relative
}

/**
 * Find the newest recorded turn whose change summary lists one file.
 *
 * The summary is keyed by the `workspace/changes` event's sequence number, so
 * the newest such event is tried first: the Client's `changes-review` resource
 * is built from `seq`/`turn`, and `index` is the file's position in that
 * summary's own `files` array. Nothing is recomputed here — a Host without the
 * shipped `workspaceChanges` service (or without a live summary for this
 * Session) answers `not-found` rather than diffing or running git.
 * @param host - Host context.
 * @param deps - the wiring's borrowed helpers.
 * @param sessionId - Session whose menu was used.
 * @param body - `{ path }`.
 * @returns the event sequence, turn, and listed-file index.
 */
async function locateChanges(host, deps, sessionId, body) {
  const root = await workspaceOf(host, deps.readHeader, sessionId)
  const target = joinInside(root, segmentsOf(body.path))
  if (target === root) refuse('not-found')
  const relative = workspacePath(root, target)

  const changes = service(host, 'workspaceChanges')
  if (typeof changes?.summary !== 'function') {
    if (deps.warnedChanges === false) {
      deps.warnedChanges = true
      host.logger?.warn?.('session-menu-plus: workspaceChanges is not mounted; changes/locate answers not-found')
    }
    refuse('not-found')
  }

  // The live Session may still hold unflushed events; the read below goes
  // through persistence, so flush first, exactly as the export route does.
  const sessions = service(host, 'sessions')
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) {
    try {
      await sessions.flush?.(live)
    } catch {
      // Read what is already durable rather than failing the lookup.
    }
  }

  const log = await deps.readLog(host, sessionId)
  if (log === undefined) refuse('not-found')
  for (let at = log.events.length - 1; at >= 0; at -= 1) {
    const event = log.events[at]
    if (event?.type !== 'workspace/changes') continue
    let summary
    try {
      summary = changes.summary(sessionId, event.seq)
    } catch {
      continue
    }
    if (Array.isArray(summary?.files) === false) continue
    const index = summary.files.findIndex((file) => sameChangesPath(file, relative))
    if (index === -1) continue
    return {
      ok: true,
      seq: event.seq,
      turn: typeof summary.turn === 'number' ? summary.turn : event.data?.turn,
      index,
    }
  }
  refuse('not-found')
}

/**
 * Serve the file context menu's workspace mutations and the change locator.
 * @param hostCtx - Host context providing the route carrier and its trust fence.
 * @param deps - the Session header and log readers borrowed from `index.js`,
 * and an optional terminal launcher (tests replace it).
 */
export function registerFsRoutes(hostCtx, deps) {
  if (typeof deps?.readHeader !== 'function' || typeof deps?.readLog !== 'function') {
    throw new Error('session-menu-plus: fs routes need the Session header reader and the log reader')
  }
  const wiring = {
    readHeader: deps.readHeader,
    readLog: deps.readLog,
    launchTerminal: deps.launchTerminal ?? launchTerminal,
    /** Whether the missing-service warning was already logged for this registration. */
    warnedChanges: false,
  }
  mount(hostCtx, CREATE_ROUTE, answer(createEntry, wiring))
  mount(hostCtx, MKDIR_ROUTE, answer(makeDirectory, wiring))
  mount(hostCtx, RENAME_ROUTE, answer(renameEntry, wiring))
  mount(hostCtx, PASTE_ROUTE, answer(pasteEntry, wiring))
  mount(hostCtx, REMOVE_ROUTE, answer(removeEntry, wiring))
  mount(hostCtx, TERMINAL_ROUTE, answer(openTerminal, wiring))
  mount(hostCtx, CHANGES_ROUTE, answer(locateChanges, wiring))
}
