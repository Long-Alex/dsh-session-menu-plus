/**
 * Host half: withdraw one Session for the Client's existing Session menu, then
 * let the Session catalog drop the row.
 *
 * The Client owns the menu row, the confirmation dialog, and the notice; this
 * half owns the bytes and the bookkeeping. It walks the same path the shipped
 * Archive already uses, so a deleted Session leaves nothing behind: transcript
 * through `sessionPersistence.locate`, projection cache through
 * `sessionProjectionCache`, spill directory, workspace membership, archive
 * marker, plus the registry's in-memory index.
 * @module dsh-session-menu-plus
 */

import { createHash } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Route the Client's confirmation calls. */
const DELETE_ROUTE = '/session-menu-plus/delete'

/** Route the Client's export calls. */
const EXPORT_ROUTE = '/session-menu-plus/export'

/** Media type and extension the browser needs to offer a save. */
const EXPORT_MEDIA = { mediaType: 'text/markdown', extension: 'md' }

/** How much of one tool argument or result an export keeps before eliding it. */
const EXPORT_CLIP = 4000

/** A stored Session identity; anything else never reaches the host services. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The JSONL backend's transcript names; nothing else in a Session directory is ours to remove. */
const SESSION_ARTIFACT = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u

/** What a Session directory may still hold after its transcript goes: the backend's writer lock. */
const SESSION_OWNED = /^(?:session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?|session\.lock)$/u

/** Host services this plugin needs to serve its route. */
export const inject = ['webServer', 'connection']

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
 * Read one Session's header, cheapest source first: the live instance, then a
 * direct read, then the backend listing.
 * @param ctx - Host context.
 * @param sessionId - Session to read.
 * @returns the header, or undefined when no backend knows this Session.
 */
async function readHeader(ctx, sessionId) {
  const live = service(ctx, 'sessions')?.get?.(sessionId)
  if (live?.header !== undefined) return live.header
  const query = service(ctx, 'sessionQuery')
  if (typeof query?.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot?.session !== undefined) return snapshot.session
    } catch {
      // Fall through to the backend listing.
    }
  }
  const persistence = service(ctx, 'sessionPersistence')
  if (typeof persistence?.list === 'function') {
    try {
      const listed = await persistence.list()
      return listed.find((item) => item.header?.id === sessionId)?.header
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Drop one Session from every workspace that still lists it.
 * @param registry - the workspace registry.
 * @param sessionId - Session to detach.
 */
async function detachFromWorkspaces(registry, sessionId) {
  for (const workspace of registry?.list?.() ?? []) {
    if (workspace.sessionIds?.includes(sessionId) !== true) continue
    try {
      await workspace.detachSession(sessionId)
    } catch {
      // One workspace refusing does not stop the deletion.
    }
  }
}

/**
 * Remove a Session's transcript and, when nothing else lives there, its
 * directory: only the backend's own files and writer lock may be inside.
 * @param locationPath - the transcript path the backend reported.
 */
async function removeTranscript(locationPath) {
  const name = basename(locationPath)
  if (SESSION_ARTIFACT.test(name) === false) {
    throw new Error(`refusing to delete unexpected Session artifact "${locationPath}"`)
  }
  const directory = dirname(locationPath)
  const entries = await readdir(directory).catch(() => [])
  const onlyOwned = entries.every((entry) => SESSION_OWNED.test(entry))
  await rm(onlyOwned ? directory : locationPath, { recursive: true, force: true })
}

/**
 * Remove the spill directory that belongs to one Session.
 * @param ctx - Host context.
 * @param sessionId - Session whose spilled tool output goes away.
 */
async function removeSpill(ctx, sessionId) {
  const root = service(ctx, 'spillStore')?.root
  if (typeof root !== 'string') return
  const directory = join(root, `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`)
  await rm(directory, { recursive: true, force: true }).catch(() => {})
}

/**
 * Forget one Session in the registry's in-memory index, so a later listing
 * cannot resurrect the row.
 * @param registry - the workspace registry.
 * @param sessionId - Session to forget.
 */
function forgetIndexed(registry, sessionId) {
  for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) {
    try {
      registry?.[key]?.delete?.(sessionId)
    } catch {
      // A read-only index is fine: the transcript is already gone.
    }
  }
}

/**
 * Read one Session's committed events through the persistence backend.
 * @param ctx - Host context.
 * @param sessionId - Session to read.
 * @returns the header and its events, or undefined when no backend has this Session.
 */
async function readLog(ctx, sessionId) {
  const persistence = service(ctx, 'sessionPersistence')
  if (typeof persistence?.open !== 'function') return undefined
  let reader
  try {
    reader = await persistence.open(sessionId, 'read')
  } catch {
    return undefined
  }
  try {
    const { events } = await reader.read(0, undefined)
    return { header: reader.header, events }
  } finally {
    await reader.close?.()
  }
}

/**
 * Shorten one long value for a Markdown export.
 * @param value - raw text.
 * @returns the text, or its head plus how much was elided.
 */
function clip(value) {
  const text = String(value ?? '')
  if (text.length <= EXPORT_CLIP) return text
  return `${text.slice(0, EXPORT_CLIP)}\n… ${text.length - EXPORT_CLIP} more characters`
}

/**
 * Fence one block so its own backticks cannot end the fence early.
 * @param value - raw text.
 * @param language - fence info string.
 * @returns a fenced code block.
 */
function fence(value, language) {
  const text = clip(value)
  const hasFence = /`{3,}/.test(text)
  const marker = hasFence ? '~~~~' : '```'
  return `${marker}${language}\n${text}\n${marker}`
}

/**
 * Join one message's text parts, ignoring reasoning and tool-call blocks: tool
 * calls are read from their own events so arguments and results stay paired.
 * @param content - message content blocks.
 * @returns the text, or an empty string.
 */
function messageText(content) {
  if (Array.isArray(content) === false) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * Render one Session's event stream as Markdown: a header, then each turn's user
 * text, assistant text, and every tool call with its arguments and result.
 * @param header - the Session's immutable header.
 * @param events - committed events in seq order.
 * @param exportedAt - export timestamp for the header line.
 * @returns the Markdown document.
 */
export function renderMarkdown(header, events, exportedAt) {
  let title
  const turns = []
  const calls = new Map()
  for (const event of events) {
    const data = event?.data ?? {}
    if (event?.type === 'session/title' && typeof data.title === 'string' && data.title.length > 0) {
      title = data.title
      continue
    }
    if (event?.type === 'turn/start') {
      turns.push({ turn: data.turn ?? turns.length + 1, time: event.time, blocks: [] })
      continue
    }
    const turn = turns[turns.length - 1]
    if (turn === undefined) continue
    if (event.type === 'user/message') {
      const text = messageText(data.content)
      if (text.length > 0) turn.blocks.push(`**User**\n\n${text}`)
    } else if (event.type === 'assistant/message') {
      const text = messageText(data.message?.content)
      if (text.length > 0) turn.blocks.push(`**Assistant**\n\n${text}`)
    } else if (event.type === 'tool/call') {
      calls.set(data.callId, { name: data.name, arguments: data.arguments, turn })
    } else if (event.type === 'tool/result') {
      const callId = data.toolCallId ?? data.message?.toolCallId
      const call = calls.get(callId)
      const result = messageText(data.message?.content)
      calls.delete(callId)
      const target = call?.turn ?? turn
      const parts = [`**Tool · \`${call?.name ?? 'unknown'}\`**`]
      if (typeof call?.arguments === 'string' && call.arguments.length > 0) {
        parts.push(`<details><summary>Arguments</summary>\n\n${fence(call.arguments, 'json')}\n\n</details>`)
      }
      parts.push(`<details><summary>Result</summary>\n\n${fence(result, 'text')}\n\n</details>`)
      target.blocks.push(parts.join('\n\n'))
    }
  }

  // A call whose result never arrived still belongs in the transcript.
  for (const [, call] of calls) {
    const parts = [`**Tool · \`${call.name ?? 'unknown'}\`**`]
    if (typeof call.arguments === 'string' && call.arguments.length > 0) {
      parts.push(`<details><summary>Arguments</summary>\n\n${fence(call.arguments, 'json')}\n\n</details>`)
    }
    parts.push('_No result was recorded._')
    call.turn.blocks.push(parts.join('\n\n'))
  }

  const lines = [
    `# ${title ?? header.id}`,
    '',
    `- Session: \`${header.id}\``,
    ...(typeof header.cwd === 'string' ? [`- Working directory: \`${header.cwd}\``] : []),
    ...(typeof header.createdAt === 'number' ? [`- Started: ${new Date(header.createdAt).toISOString()}`] : []),
    ...(typeof header.agentPreset === 'string' ? [`- Agent preset: \`${header.agentPreset}\``] : []),
    `- Exported: ${exportedAt}`,
  ]
  for (const turn of turns) {
    if (turn.blocks.length === 0) continue
    const when = typeof turn.time === 'number' ? ` · ${new Date(turn.time).toISOString()}` : ''
    lines.push('', '---', '', `## Turn ${turn.turn}${when}`, '', turn.blocks.join('\n\n'))
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Build the Markdown export payload for one Session: the stored events rendered
 * for reading.
 * @param ctx - Host context.
 * @param sessionId - Session to export.
 * @returns the outcome the Client turns into a download.
 */
async function exportSession(ctx, sessionId) {
  const sessions = service(ctx, 'sessions')
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) {
    try {
      await sessions.flush?.(live)
    } catch {
      // Export what is already durable rather than failing the whole export.
    }
  }
  const log = await readLog(ctx, sessionId)
  if (log?.header === undefined) return { ok: false, code: 'missing' }

  const content = renderMarkdown(log.header, log.events, new Date().toISOString())
  const { mediaType, extension } = EXPORT_MEDIA
  return { ok: true, mediaType, filename: `${sessionId}.${extension}`, content }
}

/**
 * Delete one Session and everything the Host keeps about it.
 * @param ctx - Host context.
 * @param sessionId - stored Session identity.
 * @returns the outcome the Client turns into a notice.
 */
async function deleteSession(ctx, sessionId) {
  if (service(ctx, 'agents')?.get?.(sessionId)?.status === 'running') return { ok: false, code: 'running' }

  const header = await readHeader(ctx, sessionId)
  if (header === undefined) return { ok: false, code: 'missing' }

  const sessions = service(ctx, 'sessions')
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) {
    try {
      await sessions.flush?.(live)
    } catch {
      // A failed flush still leaves the on-disk transcript as the thing to delete.
    }
    try {
      const entry = sessions.liveEntryFor?.(live)
      if (entry !== undefined) sessions.detachEntered?.(entry)
    } catch {
      // Detaching is best effort; leaving files behind would be worse.
    }
  }

  try {
    await service(ctx, 'sessionProjectionCache')?.delete?.(sessionId)
  } catch {
    // Older Hosts have no cache deletion; the row is withdrawn either way.
  }

  const registry = service(ctx, 'workspaceRegistry')
  try {
    await registry?.unarchiveSession?.(sessionId)
  } catch {
    // Not archived, or the set is read-only.
  }
  await detachFromWorkspaces(registry, sessionId)

  const persistence = service(ctx, 'sessionPersistence')
  if (typeof persistence?.locate !== 'function') return { ok: false, code: 'unsupported' }
  const location = await persistence.locate(header)
  if (typeof location?.path !== 'string') return { ok: false, code: 'missing' }
  try {
    await removeTranscript(location.path)
  } catch (error) {
    ctx.logger?.warn?.(`session-menu-plus: cannot remove "${location.path}": ${String(error)}`)
    return { ok: false, code: 'failed' }
  }

  await removeSpill(ctx, sessionId)
  forgetIndexed(registry, sessionId)
  // The Session catalog's declared withdrawal relay: the Client drops this row
  // without waiting for another catalog pull.
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    // The row still disappears on the next catalog pull.
  }
  return { ok: true }
}

/**
 * Serve Session deletion over the Host's own browser carrier; the Client's
 * confirmation dialog is the only caller.
 * @param ctx - Host context providing the route carrier and its trust fence.
 */
export function apply(ctx) {
  /**
   * Mount one POST route with the Host's browser-trust fence and Session identity check.
   * @param hostCtx - Host context carrying the web server and its fence.
   * @param path - exact route path.
   * @param handle - answers one validated Session identity.
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
          respond(response, 200, await handle(hostCtx, sessionId))
        } catch (error) {
          hostCtx.logger?.warn?.(`session-menu-plus: ${path} failed: ${String(error)}`)
          respond(response, 500, { ok: false, code: 'failed' })
        }
      },
    }), `dsh-session-menu-plus: ${path}`)
  }

  ctx.inject(['webServer', 'connection'], (hostCtx) => {
    mount(hostCtx, DELETE_ROUTE, (host, sessionId) => deleteSession(host, sessionId))
    mount(hostCtx, EXPORT_ROUTE, exportSession)
  })
}
