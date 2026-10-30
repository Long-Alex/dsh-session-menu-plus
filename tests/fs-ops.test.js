/**
 * Host-half checks for the file menu's six workspace routes: create, mkdir,
 * rename, paste (copy and cut), remove, and the terminal opener. Each route
 * answers only a request confined to the Session's own workspace, refuses a
 * name that is not one path segment, an occupied destination, a source that is
 * not there, and anything spelled outside the workspace — including a symlink
 * that resolves outside it.
 */

import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'

/**
 * Boot the Host half against a throwaway workspace holding one file, one
 * directory with one file, and a directory outside the workspace.
 * @returns the mounted routes, the workspace, and the outside directory.
 */
async function mount(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'session-menu-plus-fs-'))
  const workspace = join(home, 'workspace')
  const outside = join(home, 'outside')
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'notes.md'), '# notes\n')
  await writeFile(join(workspace, 'docs', 'a.txt'), 'a')
  await writeFile(join(outside, 'secret.txt'), 'secret')

  // Two recorded turns, each announced by its own `workspace/changes` event.
  const events = [
    { type: 'session', seq: 0, data: {} },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'workspace/changes', seq: 7, data: { turn: 1 } },
    { type: 'turn/start', seq: 8, time: 2, data: { turn: 2 } },
    { type: 'workspace/changes', seq: 12, data: { turn: 2 } },
  ]
  const summaries = {
    7: {
      turn: 1,
      cwd: workspace,
      files: [{ path: 'docs/a.txt', display: 'docs/a.txt' }, { path: 'notes.md', display: 'notes.md' }],
      total: 2,
    },
    12: {
      turn: 2,
      cwd: workspace,
      files: [{ path: 'notes.md', display: 'notes.md' }, { path: 'docs/b.txt', display: 'docs/b.txt' }],
      total: 2,
    },
  }

  process.env.DSH_HOME = home
  const { apply } = await import('../index.js')
  const routes = []
  const warnings = []
  const header = { id: SESSION, cwd: workspace }
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    sessions: { get: (id) => (id === SESSION ? { header } : undefined) },
    sessionPersistence: {
      list: async () => [{ header }],
      open: async (id) => {
        if (id !== SESSION) throw new Error('no such Session')
        return { header, read: async () => ({ events }), close: async () => {} }
      },
    },
    workspaceChanges: { summary: (id, seq) => (id === SESSION ? summaries[seq] : undefined) },
    get: (name) => ctx[name],
    inject: (names, callback) => { callback(ctx) },
    effect: (callback) => { ctx.cleanups.push(callback()) },
    cleanups: [],
    logger: { warn: (message) => { warnings.push(message) } },
  }
  if (options.withoutChanges === true) delete ctx.workspaceChanges
  apply(ctx)
  const route = (path) => routes.find((entry) => entry.path === path)
  return { route, routes, workspace, home, outside, warnings }
}

/**
 * Call one route with a JSON body.
 * @param route - the registered route.
 * @param body - request body value.
 * @returns the recorded status and parsed reply.
 */
async function call(route, body) {
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) },
  }
  const recorded = { status: 0, payload: '' }
  const response = {
    headersSent: false,
    writeHead(status) { recorded.status = status },
    end(payload) { recorded.payload = payload ?? '' },
  }
  await route.handler(request, response)
  return { status: recorded.status, value: JSON.parse(recorded.payload) }
}

/**
 * Post one file-menu request for the fixture Session.
 * @param route - the registered route.
 * @param body - route fields without `sessionId`.
 * @returns the recorded status and parsed reply.
 */
async function post(route, body) {
  return call(route, { sessionId: SESSION, ...body })
}

/**
 * Report whether one path exists.
 * @param path - absolute path.
 * @returns true when the filesystem has an entry there.
 */
async function there(path) {
  return lstat(path).then(() => true, () => false)
}

test('creates one empty file in the directory the menu named', async () => {
  const { route, workspace } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/create'), { path: '', name: 'draft.md' }), {
    status: 200, value: { ok: true, path: 'draft.md' },
  })
  assert.equal(await readFile(join(workspace, 'draft.md'), 'utf8'), '')
  assert.deepEqual(await post(route('/session-menu-plus/fs/create'), { path: 'docs', name: 'b.txt' }), {
    status: 200, value: { ok: true, path: 'docs/b.txt' },
  })
  assert.equal(await readFile(join(workspace, 'docs', 'b.txt'), 'utf8'), '')
})

test('refuses a file whose name is already taken', async () => {
  const { route } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/create'), { path: '', name: 'notes.md' }), {
    status: 200, value: { ok: false, code: 'exists' },
  })
})

test('refuses a create name that is not one path segment', async () => {
  const { route } = await mount()
  for (const name of ['', '.', '..', 'a/b', 'a\\b', `x${String.fromCharCode(0)}y`, 'x'.repeat(256)]) {
    assert.deepEqual(await post(route('/session-menu-plus/fs/create'), { path: '', name }), {
      status: 200, value: { ok: false, code: 'invalid-name' },
    }, `name ${JSON.stringify(name)}`)
  }
})

test('refuses a create whose path leaves the workspace', async () => {
  const { route } = await mount()
  for (const path of ['../outside', '/etc', 'docs/../../outside', '..\\outside']) {
    assert.deepEqual(await post(route('/session-menu-plus/fs/create'), { path, name: 'x' }), {
      status: 200, value: { ok: false, code: 'outside-workspace' },
    }, `path ${path}`)
  }
})

test('refuses a create in a directory that is not there', async () => {
  const { route } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/create'), { path: 'ghost', name: 'x' }), {
    status: 200, value: { ok: false, code: 'not-found' },
  })
})

test('makes one directory and refuses one that is already there', async () => {
  const { route, workspace } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/mkdir'), { path: '', name: 'assets' }), {
    status: 200, value: { ok: true, path: 'assets' },
  })
  assert.equal((await lstat(join(workspace, 'assets'))).isDirectory(), true)
  assert.deepEqual(await post(route('/session-menu-plus/fs/mkdir'), { path: '', name: 'assets' }), {
    status: 200, value: { ok: false, code: 'exists' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/mkdir'), { path: '', name: 'a/b' }), {
    status: 200, value: { ok: false, code: 'invalid-name' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/mkdir'), { path: '../outside', name: 'x' }), {
    status: 200, value: { ok: false, code: 'outside-workspace' },
  })
})

test('renames a file in place and keeps its extension', async () => {
  const { route, workspace } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: 'notes.md', name: 'readme' }), {
    status: 200, value: { ok: true, path: 'readme.md' },
  })
  assert.equal(await there(join(workspace, 'notes.md')), false)
  assert.equal(await readFile(join(workspace, 'readme.md'), 'utf8'), '# notes\n')
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: 'readme.md', name: 'log.txt' }), {
    status: 200, value: { ok: true, path: 'log.txt' },
  })
})

test('renames a directory without inventing an extension', async () => {
  const { route, workspace } = await mount()
  await mkdir(join(workspace, 'v1.2'))
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: 'v1.2', name: 'latest' }), {
    status: 200, value: { ok: true, path: 'latest' },
  })
  assert.equal((await lstat(join(workspace, 'latest'))).isDirectory(), true)
})

test('refuses a rename onto another entry, a missing source, and a bad name', async () => {
  const { route, workspace } = await mount()
  await writeFile(join(workspace, 'other.md'), 'other')
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: 'notes.md', name: 'other' }), {
    status: 200, value: { ok: false, code: 'exists' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: 'ghost.md', name: 'x' }), {
    status: 200, value: { ok: false, code: 'not-found' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: 'notes.md', name: '..' }), {
    status: 200, value: { ok: false, code: 'invalid-name' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: '../outside/secret.txt', name: 'x' }), {
    status: 200, value: { ok: false, code: 'outside-workspace' },
  })
})

test('copies an entry into a directory and leaves the source in place', async () => {
  const { route, workspace } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), { path: 'docs', mode: 'copy', source: 'notes.md' }), {
    status: 200, value: { ok: true, path: 'docs/notes.md' },
  })
  assert.equal(await readFile(join(workspace, 'docs', 'notes.md'), 'utf8'), '# notes\n')
  assert.equal(await readFile(join(workspace, 'notes.md'), 'utf8'), '# notes\n')
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), { path: 'docs', mode: 'copy', source: 'notes.md' }), {
    status: 200, value: { ok: false, code: 'exists' },
  })
})

test('cuts an entry into a directory', async () => {
  const { route, workspace } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), { path: 'docs', mode: 'cut', source: 'notes.md' }), {
    status: 200, value: { ok: true, path: 'docs/notes.md' },
  })
  assert.equal(await there(join(workspace, 'notes.md')), false)
  assert.equal(await readFile(join(workspace, 'docs', 'notes.md'), 'utf8'), '# notes\n')
})

test('refuses a paste with no source, a mode it does not have, and one into itself', async () => {
  const { route } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), { path: 'docs', mode: 'copy', source: 'ghost' }), {
    status: 200, value: { ok: false, code: 'not-found' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), { path: 'docs', mode: 'move', source: 'notes.md' }), {
    status: 200, value: { ok: false, code: 'invalid' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), { path: 'docs', mode: 'copy', source: 'docs' }), {
    status: 200, value: { ok: false, code: 'busy' },
  })
})

test('refuses a paste that reads outside the workspace', async () => {
  const { route } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), {
    path: 'docs', mode: 'copy', source: '../outside/secret.txt',
  }), { status: 200, value: { ok: false, code: 'outside-workspace' } })
})

test('removes one file and one directory tree', async () => {
  const { route, workspace } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/remove'), { path: 'notes.md' }), {
    status: 200, value: { ok: true, path: 'notes.md' },
  })
  assert.equal(await there(join(workspace, 'notes.md')), false)
  assert.deepEqual(await post(route('/session-menu-plus/fs/remove'), { path: 'docs' }), {
    status: 200, value: { ok: true, path: 'docs' },
  })
  assert.equal(await there(join(workspace, 'docs')), false)
})

test('refuses to remove the workspace root, an outside path, or a missing one', async () => {
  const { route } = await mount()
  assert.deepEqual(await post(route('/session-menu-plus/fs/remove'), { path: '' }), {
    status: 200, value: { ok: false, code: 'busy' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/remove'), { path: '../outside' }), {
    status: 200, value: { ok: false, code: 'outside-workspace' },
  })
  assert.deepEqual(await post(route('/session-menu-plus/fs/remove'), { path: 'ghost' }), {
    status: 200, value: { ok: false, code: 'not-found' },
  })
})

test('follows a symlink row, never its target', async (context) => {
  const { route, workspace, outside } = await mount()
  try {
    await symlink(outside, join(workspace, 'escape'))
    await symlink(join(workspace, 'notes.md'), join(workspace, 'pointer.md'))
  } catch {
    context.skip('this filesystem cannot create symlinks')
    return
  }
  // Reading through a link out of the workspace is refused.
  assert.deepEqual(await post(route('/session-menu-plus/fs/paste'), {
    path: 'docs', mode: 'copy', source: 'escape',
  }), { status: 200, value: { ok: false, code: 'outside-workspace' } })
  // Removing and renaming the row itself only touches the link.
  assert.deepEqual(await post(route('/session-menu-plus/fs/remove'), { path: 'escape' }), {
    status: 200, value: { ok: true, path: 'escape' },
  })
  assert.equal(await there(join(workspace, 'escape')), false)
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret')
  assert.deepEqual(await post(route('/session-menu-plus/fs/rename'), { path: 'pointer.md', name: 'alias' }), {
    status: 200, value: { ok: true, path: 'alias.md' },
  })
  assert.equal((await lstat(join(workspace, 'alias.md'))).isSymbolicLink(), true)
  assert.equal(await readFile(join(workspace, 'notes.md'), 'utf8'), '# notes\n')
})

test('answers only its own POST with a Session identity it knows', async () => {
  const { route } = await mount()
  const create = route('/session-menu-plus/fs/create')
  assert.deepEqual(await call(create, { sessionId: 'nope', path: '', name: 'x' }), {
    status: 400, value: { ok: false, code: 'invalid' },
  })
  assert.deepEqual(await call(create, {
    sessionId: 'session-00000000-0000-0000-0000-000000000000', path: '', name: 'x',
  }), { status: 200, value: { ok: false, code: 'not-found' } })
  const get = { ...create, handler: create.handler }
  const recorded = { status: 0, payload: '' }
  await get.handler({ method: 'GET', async *[Symbol.asyncIterator]() {} }, {
    headersSent: false,
    writeHead(status) { recorded.status = status },
    end(payload) { recorded.payload = payload ?? '' },
  })
  assert.deepEqual({ status: recorded.status, value: JSON.parse(recorded.payload) }, {
    status: 405, value: { ok: false, code: 'method' },
  })
})

test('opens the Host terminal at the directory the menu named', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-menu-plus-term-'))
  const workspace = join(home, 'workspace')
  await mkdir(join(workspace, 'docs'), { recursive: true })
  await writeFile(join(workspace, 'docs', 'a.txt'), 'a')
  const routes = []
  const launched = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    get: () => undefined,
    effect: (callback) => { ctx.cleanups.push(callback()) },
    cleanups: [],
    logger: { warn: () => {} },
  }
  const { registerFsRoutes } = await import('../fs-ops.js')
  registerFsRoutes(ctx, {
    readHeader: async () => ({ id: SESSION, cwd: workspace }),
    readLog: async () => ({ header: { id: SESSION, cwd: workspace }, events: [] }),
    launchTerminal: async (directory) => { launched.push(directory); return true },
  })
  const terminal = routes.find((entry) => entry.path === '/session-menu-plus/open-terminal')
  const expected = await realpath(join(workspace, 'docs'))
  assert.deepEqual(await post(terminal, { path: 'docs' }), {
    status: 200, value: { ok: true, path: expected },
  })
  assert.deepEqual(await post(terminal, { path: 'docs/a.txt' }), {
    status: 200, value: { ok: true, path: expected },
  })
  assert.deepEqual(launched, [expected, expected])
  assert.deepEqual(await post(terminal, { path: 'ghost' }), {
    status: 200, value: { ok: false, code: 'not-found' },
  })
})

test('reports a Host with no terminal launcher as busy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-menu-plus-term-'))
  const routes = []
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    get: () => undefined,
    effect: (callback) => { ctx.cleanups.push(callback()) },
    cleanups: [],
    logger: { warn: () => {} },
  }
  const { registerFsRoutes } = await import('../fs-ops.js')
  registerFsRoutes(ctx, {
    readHeader: async () => ({ id: SESSION, cwd: home }),
    readLog: async () => undefined,
    launchTerminal: async () => false,
  })
  const terminal = routes.find((entry) => entry.path === '/session-menu-plus/open-terminal')
  assert.deepEqual(await post(terminal, { path: '' }), {
    status: 200, value: { ok: false, code: 'busy' },
  })
  assert.deepEqual(await readdir(home), [])
})

test('fails loud when the wiring forgets the Session header reader', async () => {
  const ctx = {
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => undefined },
    get: () => undefined,
    effect: (callback) => { ctx.cleanups.push(callback()) },
    cleanups: [],
  }
  const { registerFsRoutes } = await import('../fs-ops.js')
  assert.throws(() => registerFsRoutes(ctx, {}), /Session header reader/)
  assert.throws(() => registerFsRoutes(ctx, { readHeader: async () => undefined }), /log reader/)
})

test('locates the newest turn whose summary lists one file', async () => {
  const { route } = await mount()
  const locate = route('/session-menu-plus/changes/locate')
  assert.deepEqual(await post(locate, { path: 'docs/b.txt' }), {
    status: 200, value: { ok: true, seq: 12, turn: 2, index: 1 },
  })
  // Listed by both turns: the newer event wins, and the index is that
  // summary's own.
  assert.deepEqual(await post(locate, { path: 'notes.md' }), {
    status: 200, value: { ok: true, seq: 12, turn: 2, index: 0 },
  })
  assert.deepEqual(await post(locate, { path: 'docs/a.txt' }), {
    status: 200, value: { ok: true, seq: 7, turn: 1, index: 0 },
  })
})

test('answers not-found for a file no turn listed', async () => {
  const { route } = await mount()
  const locate = route('/session-menu-plus/changes/locate')
  assert.deepEqual(await post(locate, { path: 'ghost.md' }), {
    status: 200, value: { ok: false, code: 'not-found' },
  })
  // The workspace root is not a changed file.
  assert.deepEqual(await post(locate, { path: '' }), {
    status: 200, value: { ok: false, code: 'not-found' },
  })
  assert.deepEqual(await post(locate, { path: '../outside/secret.txt' }), {
    status: 200, value: { ok: false, code: 'outside-workspace' },
  })
})

test('answers not-found and warns once when the Host has no change service', async () => {
  const { route, warnings } = await mount({ withoutChanges: true })
  const locate = route('/session-menu-plus/changes/locate')
  const expected = { status: 200, value: { ok: false, code: 'not-found' } }
  assert.deepEqual(await post(locate, { path: 'notes.md' }), expected)
  assert.deepEqual(await post(locate, { path: 'notes.md' }), expected)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /workspaceChanges/)
})
