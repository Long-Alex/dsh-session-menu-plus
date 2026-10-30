/**
 * Host-half checks for the two Client routes: deletion answers only the Client's
 * own confirmation call and removes exactly the stored Session it was given, even
 * when this process also holds that Session live; export answers with that
 * Session's header and its untouched event stream.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const LIVE = 'session-99999999-8888-7777-6666-555555555555'

/**
 * Boot the Host half against a throwaway home with the Host services it borrows.
 * @returns the captured route, the emitted events, and the fake home.
 */
async function mount() {
  const home = await mkdtemp(join(tmpdir(), 'session-menu-plus-'))
  const project = join(home, 'sessions', '--tmp-project--')
  const stored = join(project, SESSION)
  await mkdir(stored, { recursive: true })
  await writeFile(join(stored, 'session.v4.jsonl.zstd'), 'log')
  const cache = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, `${SESSION}.json`), '{}')

  process.env.DSH_HOME = home
  const { apply } = await import('../index.js')
  const routes = []
  const emitted = []
  const detached = []
  const archived = []
  const ctx = {
    head: {},
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    sessionPersistence: {
      list: async () => [{ header: { id: SESSION, cwd: '/tmp' } }],
      locate: (header) => ({ path: join(stored, 'session.v4.jsonl.zstd'), header }),
      open: async (id) => {
        if (id !== SESSION) throw new Error('no such Session')
        return {
          header: { id, cwd: '/tmp', version: 4, createdAt: 1, isSeeded: false },
          read: async () => ({ events: [
            { type: 'session', seq: 0 },
            { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
            { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'Fix the build' }] } },
            { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'Looking now.' }] } } },
            { type: 'tool/call', seq: 4, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
            { type: 'tool/result', seq: 5, data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } },
          ] }),
          close: async () => {},
        }
      },
    },
    sessionProjectionCache: { delete: async (id) => { await rm(join(cache, `${id}.json`), { force: true }) } },
    workspaceRegistry: {
      list: () => [{ sessionIds: [SESSION], detachSession: async (id) => { detached.push(id) } }],
      unarchiveSession: async (id) => { archived.push(id) },
    },
    emit: (event, id) => { emitted.push(`${event}:${id}`) },
    effect: (callback) => { ctx.cleanups.push(callback()) },
    get: (name) => ctx[name],
    inject: (names, callback) => { callback(ctx) },
    cleanups: [],
    logger: { warn: () => {} },
  }
  apply(ctx)
  return {
    route: routes[0], exportRoute: routes[1], emitted, home, stored, cache, detached, archived,
  }
}

/**
 * Call the route with one JSON body and no browser trust.
 * @param route - the registered route.
 * @param body - request body text.
 * @returns the recorded status and parsed reply.
 */
async function call(route, body) {
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
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

test('deletes one stored Session and withdraws its catalog row', async () => {
  const { route, emitted, stored, cache, detached, archived } = await mount()
  assert.deepEqual(await call(route, JSON.stringify({ sessionId: SESSION })), {
    status: 200, value: { ok: true },
  })
  assert.deepEqual(await readdir(join(stored, '..')), [])
  assert.deepEqual(await readdir(cache), [])
  assert.deepEqual(detached, [SESSION])
  assert.deepEqual(archived, [SESSION])
  assert.deepEqual(emitted, [`api-session/removed:${SESSION}`])
})

test('deletes a stored Session this process also holds live', async () => {
  const flushed = []
  const detachedEntries = []
  const home = await mkdtemp(join(tmpdir(), 'session-menu-plus-live-'))
  const stored = join(home, 'sessions', '--tmp-project--', LIVE)
  await mkdir(stored, { recursive: true })
  await writeFile(join(stored, 'session.v4.jsonl.zstd'), 'log')
  process.env.DSH_HOME = home
  const { apply } = await import('../index.js')
  const routes = []
  const emitted = []
  const liveEntry = { id: LIVE }
  const local = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
    agents: { get: () => undefined },
    sessions: {
      get: (id) => (id === LIVE ? { header: { id, cwd: '/tmp' } } : undefined),
      flush: async (session) => { flushed.push(session.header.id) },
      liveEntryFor: (session) => (session.header.id === LIVE ? liveEntry : undefined),
      detachEntered: (entry) => { detachedEntries.push(entry.id) },
    },
    sessionPersistence: { locate: () => ({ path: join(stored, 'session.v4.jsonl.zstd') }) },
    sessionProjectionCache: { delete: async () => {} },
    workspaceRegistry: { list: () => [], unarchiveSession: async () => {} },
    get: (name) => local[name],
    emit: (event, id) => { emitted.push(`${event}:${id}`) },
    inject: (names, callback) => { callback(local) },
    effect: (callback) => { callback(); return () => {} },
    logger: { warn: () => {} },
  }
  apply(local)
  assert.deepEqual(await call(routes[0], JSON.stringify({ sessionId: LIVE })), {
    status: 200, value: { ok: true },
  })
  assert.deepEqual(await readdir(join(stored, '..')), [])
  assert.deepEqual(flushed, [LIVE])
  assert.deepEqual(detachedEntries, [LIVE])
  assert.deepEqual(emitted, [`api-session/removed:${LIVE}`])
})

test('reports a Session the store does not have', async () => {
  const { route } = await mount()
  const missing = JSON.stringify({ sessionId: 'session-00000000-0000-0000-0000-000000000000' })
  assert.deepEqual(await call(route, missing), { status: 200, value: { ok: false, code: 'missing' } })
})

test('refuses a Session identity that is not one', async () => {
  const { route } = await mount()
  assert.deepEqual(await call(route, JSON.stringify({ sessionId: '../../etc' })), {
    status: 400, value: { ok: false, code: 'invalid' },
  })
})

test('renders one stored Session as Markdown turns and tool calls', async () => {
  const { exportRoute } = await mount()
  const { status, value } = await call(exportRoute, JSON.stringify({ sessionId: SESSION }))
  assert.equal(status, 200)
  assert.equal(value.ok, true)
  assert.equal(value.mediaType, 'text/markdown')
  assert.equal(value.filename, `${SESSION}.md`)
  assert.match(value.content, /^# /)
  assert.match(value.content, /\*\*User\*\*/)
  assert.match(value.content, /\*\*Assistant\*\*/)
  assert.match(value.content, /\*\*Tool · `bash`\*\*/)
  assert.match(value.content, /<details><summary>Result<\/summary>/)
})

test('reports a Session the backend cannot read', async () => {
  const { exportRoute } = await mount()
  const absent = JSON.stringify({ sessionId: 'session-00000000-0000-0000-0000-000000000000' })
  assert.deepEqual(await call(exportRoute, absent), { status: 200, value: { ok: false, code: 'missing' } })
})

test('refuses an export identity that is not one', async () => {
  const { exportRoute } = await mount()
  assert.deepEqual(await call(exportRoute, JSON.stringify({ sessionId: 'nope' })), {
    status: 400, value: { ok: false, code: 'invalid' },
  })
})
