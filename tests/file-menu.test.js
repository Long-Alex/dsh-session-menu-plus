/**
 * Client-half checks for the file menu: which rows each target gets and in
 * which order, when 粘贴 is available, what the name/confirm dialogs post, when
 * the review row appears, and that both dictionaries carry the same keys.
 *
 * One browser script is served per plugin, so the rows live inside `client.js`'s
 * loader factory. This check loads that script through a capturing
 * `window.__ModuleLoader__`, runs the factory, and drives the `fileMenu` export
 * seam — the shipped registration, not a copy.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

/** A fake React: elements keep their props and kids, so the check can press buttons. */
const React = {
  Fragment: 'Fragment',
  createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids }),
  useState: initial => [initial, () => {}],
  useSyncExternalStore: (subscribe, snapshot) => {
    subscribe(() => {})
    return snapshot()
  },
}

/**
 * Copy one value out of the script's realm so deep comparisons do not depend on
 * which context created the object.
 * @param value - any JSON-safe value produced by the script.
 * @returns the same value as plain data.
 */
const plain = value => JSON.parse(JSON.stringify(value))

/** Let one dialog submission settle (its notice lands in a microtask). */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** The check's own translate: keys plus their interpolation values, as text. */
const translate = (key, values) => (values === undefined ? key : `${key}${JSON.stringify(values)}`)

/**
 * Load `client.js` through a capturing module loader and register the file menu
 * against a recording client context.
 * @param options - the fetch answer the script's host calls receive.
 * @returns the recorded registrations plus the handles the checks use.
 */
async function mount(options = {}) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const context = {
    console,
    TextEncoder,
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    window: { __ModuleLoader__: { load: options_ => { context.__loaded = options_ } }, addEventListener: () => {}, localStorage: { getItem: () => null, setItem: () => {} } },
  }
  vm.createContext(context)
  vm.runInContext(source, context)

  const load = specifier => (specifier === 'react' ? React : new Proxy({}, { get: (_target, name) => String(name) }))
  const module = context.__loaded.factory(load)
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual([...module.inject], ['slots', 'locale', 'sessions'])
  assert.equal(typeof module.fileMenu.registerFileMenu, 'function')

  const menus = []
  const icons = []
  const overlays = []
  const notices = []
  const posts = []
  const opened = []
  const ctx = {
    effect: callback => callback(),
    contextMenus: {
      register: (contribution) => { menus.push(contribution); return () => {} },
      notify: (text, success) => { notices.push({ text, success }) },
    },
    slots: {
      inject: (name, factory) => {
        const produced = factory()
        const sink = name === 'contextMenu.icon' ? icons : overlays
        if (produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function') {
          for (const item of produced) sink.push(item)
        } else sink.push(produced)
        return () => {}
      },
      register: (registration, Component) => ({ registration, Component }),
    },
    locale: { bind: () => translate },
    sessions: {
      list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } }, s2: { id: 's2', retainedBy: {} } } }) },
    },
    sidebarRight: { openResource: (address, openOptions) => { opened.push({ address, openOptions }) } },
  }
  context.fetch = async (route, init) => {
    posts.push({ route, body: JSON.parse(init.body) })
    return options.fetch === undefined ? { ok: true, json: async () => ({ ok: true }) } : options.fetch(route, JSON.parse(init.body))
  }
  module.fileMenu.registerFileMenu(ctx, translate, load)

  /** Resolve every contribution for one target, ordered the way the menu orders them. @returns the rows in menu order. */
  const menuFor = async (kind, path, sessionId = 's1') => {
    const ordered = menus.filter(item => item.target === kind).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const rows = []
    for (const contribution of ordered) {
      rows.push(...await contribution.resolve({ sessionId, path }, new AbortController().signal))
    }
    return rows
  }
  return { menus, icons, overlays, notices, posts, opened, menuFor, dictionaries: module.fileMenu }
}

test('the file menu lists our rows in spec order without the shipped ones', async () => {
  const menu = await mount()
  const rows = await menu.menuFor('file', 'src/deep/a.js')
  assert.deepEqual(rows.map(row => row.id), ['terminal', 'rename', 'cut', 'copy', 'remove', 'copyRelativePath', 'addToChat'])
  assert.deepEqual(rows.map(row => row.separatorBefore === true),
    [false, true, false, false, false, true, true])
  assert.deepEqual(rows.filter(row => row.danger === true).map(row => row.id), ['remove'])
  assert.equal(rows.some(row => row.id === 'paste'), false)
  // Every row names an icon key this module registers.
  const keys = rows.map(row => row.icon.key)
  assert.deepEqual(new Set(keys), new Set(menu.icons
    .filter(entry => keys.includes(entry.registration.key))
    .map(entry => entry.registration.key)))
  // Every row label exists in both dictionaries.
  for (const row of rows) {
    assert.notEqual(menu.dictionaries.zh[row.label], undefined)
    assert.notEqual(menu.dictionaries.en[row.label], undefined)
  }
})

test('the directory menu adds create rows and a paste row that follows the clipboard', async () => {
  const menu = await mount()
  const rows = await menu.menuFor('directory', 'src')
  assert.deepEqual(rows.map(row => row.id),
    ['terminal', 'createFile', 'createFolder', 'rename', 'cut', 'copy', 'paste', 'remove', 'copyRelativePath'])
  assert.equal(rows.find(row => row.id === 'paste').disabled, true)
  rows.find(row => row.id === 'cut').run()
  const afterCut = await menu.menuFor('directory', 'src')
  assert.equal(afterCut.find(row => row.id === 'paste').disabled, false)
  afterCut.find(row => row.id === 'paste').run()
  await settle()
  assert.deepEqual(plain(menu.posts.filter(post => post.route.includes('/fs/')).at(-1)), {
    route: '/session-menu-plus/fs/paste',
    body: { sessionId: 's1', path: 'src', mode: 'cut', source: 'src' },
  })
  // A transfer remembered in one Session is not pasteable in another.
  const otherSession = await menu.menuFor('directory', 'src', 's2')
  assert.equal(otherSession.find(row => row.id === 'paste').disabled, true)
})

test('create and rename dialogs post one name and report the host answer', async () => {
  const create = await mount()
  const createRows = await create.menuFor('directory', 'docs')
  createRows.find(row => row.id === 'createFile').run()
  const dialog = create.overlays[0].Component({ t: translate })
  const form = dialog.type(dialog.props)
  assert.equal(form.props.title, 'file.dialog.create.title')
  // The empty input is refused locally, before any route call.
  await form.props.footer.kids[1].props.onClick()
  await settle()
  assert.deepEqual(create.posts.filter(post => post.route.includes('/fs/')), [])
  assert.deepEqual(plain(create.notices), [{ text: 'file.error.invalidName', success: false }])

  const rename = await mount()
  const renameRows = await rename.menuFor('file', 'src/deep/renamed.js')
  renameRows.find(row => row.id === 'rename').run()
  const renameDialog = rename.overlays[0].Component({ t: translate })
  const renameForm = renameDialog.type(renameDialog.props)
  assert.equal(renameForm.props.title, 'file.dialog.rename.title')
  await renameForm.props.footer.kids[1].props.onClick()
  await settle()
  assert.deepEqual(plain(rename.posts.filter(post => post.route.includes('/fs/'))), [{
    route: '/session-menu-plus/fs/rename',
    body: { sessionId: 's1', path: 'src/deep/renamed.js', name: 'renamed.js' },
  }])
  assert.deepEqual(plain(rename.notices), [{ text: 'file.toast.renamed{"name":"renamed.js"}', success: true }])
})

test('the remove dialog is destructive and posts the target path', async () => {
  const menu = await mount()
  const rows = await menu.menuFor('file', 'src/deep/a.js')
  rows.find(row => row.id === 'remove').run()
  const dialog = menu.overlays[0].Component({ t: translate })
  const form = dialog.type(dialog.props)
  assert.equal(form.props.description, 'file.dialog.remove.desc{"name":"a.js"}')
  assert.equal(form.props.footer.kids[1].props.className, 'smp-danger')
  await form.props.footer.kids[1].props.onClick()
  await settle()
  assert.deepEqual(plain(menu.posts.filter(post => post.route.includes('/fs/'))), [{
    route: '/session-menu-plus/fs/remove',
    body: { sessionId: 's1', path: 'src/deep/a.js' },
  }])
})

test('a refused host answer surfaces its own sentence', async () => {
  const menu = await mount({ fetch: () => ({ ok: true, json: async () => ({ ok: false, code: 'exists' }) }) })
  const rows = await menu.menuFor('file', 'src/deep/renamed.js')
  // The rename dialog prefills the current basename, so it submits a valid name.
  rows.find(row => row.id === 'rename').run()
  const dialog = menu.overlays[0].Component({ t: translate })
  const form = dialog.type(dialog.props)
  await form.props.footer.kids[1].props.onClick()
  await settle()
  assert.deepEqual(plain(menu.notices), [{ text: 'file.error.exists', success: false }])
})

test('a terminal the host cannot start reports its own sentence', async () => {
  const menu = await mount({ fetch: () => ({ ok: true, json: async () => ({ ok: false, code: 'busy' }) }) })
  const rows = await menu.menuFor('directory', 'src')
  rows.find(row => row.id === 'terminal').run()
  await settle()
  assert.deepEqual(plain(menu.notices), [{ text: 'file.error.terminal', success: false }])
  assert.deepEqual(plain(menu.posts.filter(post => post.route.includes('open-terminal'))), [{
    route: '/session-menu-plus/open-terminal',
    body: { sessionId: 's1', path: 'src' },
  }])
})

test('the review row exists only where the host reports a turn and the view shows that Session', async () => {
  const absent = await mount({ fetch: () => ({ ok: false, json: async () => ({}) }) })
  assert.equal((await absent.menuFor('file', 'src/a.js')).some(row => row.id === 'viewChanges'), false)

  const present = await mount({ fetch: () => ({ ok: true, json: async () => ({ ok: true, seq: 42, turn: 3, index: 1 }) }) })
  const rows = await present.menuFor('file', 'src/a.js')
  const review = rows.find(row => row.id === 'viewChanges')
  assert.ok(review !== undefined)
  review.run()
  assert.deepEqual(plain(present.opened), [{
    address: 'dsh-resource://changes-review/session/s1/42/3',
    openOptions: { params: { index: 1 } },
  }])
  // The tab belongs to the Session whose log owns the sequence, so another
  // Session's menu does not open it in the pane on screen.
  assert.equal((await present.menuFor('file', 'src/a.js', 's2')).some(row => row.id === 'viewChanges'), false)
})

test('both dictionaries carry the same keys', async () => {
  const menu = await mount()
  const { zh, en } = menu.dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const fileKeys = Object.keys(zh).filter(key => key.startsWith('file.'))
  assert.equal(fileKeys.length, 44)
})
