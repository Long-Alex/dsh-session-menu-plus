/**
 * Client half: the Session menu opens on right-click, and one destructive row
 * there deletes that Session behind a confirmation dialog.
 *
 * The menu itself, its rows, and its keyboard walk belong to the workspace
 * browser; this plugin only adds one row through the seat the browser declares
 * and routes the row's covered gesture onto the browser's own More trigger. The
 * dialog, the notice, and their styling come from the shared Client primitives,
 * so they match the rest of the application.
 * @module dsh-session-menu-plus
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-menu-plus',
  factory(require) {
    const React = require('react')
    const {
      Button, IconCheckCircleFillRegular, IconCheckCircleOutlineRegular, IconDownloadOutlineRegular,
      IconTrashOutlineRegular, MenuItemButton, Modal, StateDot, Toast,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Dictionary namespace owned by this plugin. */
    const NS = 'session-menu-plus'

    /** Simplified Chinese dictionary. */
    const zh = {
      'menu.markRead': '标记为已读',
      'menu.markUnread': '标记为未读',
      'menu.exportMarkdown': '导出为 Markdown',
      'menu.deleteSession': '删除会话',
      'delete.confirm.title': '删除此会话？',
      'session.untitled': '未命名',
      'delete.confirm.desc': '“{title}”的会话记录将从本机永久删除，无法恢复。',
      'delete.confirm.action': '删除会话',
      'delete.confirm.pending': '正在删除会话…',
      'toast.exported': '会话已导出',
      'toast.exportFailed': '导出失败，请稍后重试',
      'toast.deleted': '会话已删除',
      'toast.deleteFailed': '删除失败，请稍后重试',
      'toast.missing': '该会话已不存在',
      'toast.running': '该会话正在运行，等它结束后再删',
      'unread.mark': '未读',
    }

    /** English dictionary. */
    const en = {
      'menu.markRead': 'Mark as read',
      'menu.markUnread': 'Mark as unread',
      'menu.exportMarkdown': 'Export as Markdown',
      'menu.deleteSession': 'Delete session',
      'delete.confirm.title': 'Delete this session?',
      'session.untitled': 'Untitled',
      'delete.confirm.desc': '“{title}” will be deleted from this device permanently. This cannot be undone.',
      'delete.confirm.action': 'Delete session',
      'delete.confirm.pending': 'Deleting session…',
      'toast.exported': 'Session exported',
      'toast.exportFailed': 'Could not export the session. Try again',
      'toast.deleted': 'Session deleted',
      'toast.deleteFailed': 'Could not delete the session. Try again',
      'toast.missing': 'That session no longer exists',
      'toast.running': 'That session is running. Delete it once it settles',
      'unread.mark': 'Unread',
    }

    /** Row styling the shared primitives do not carry: the destructive confirm label and its pending line,
     * matching the workspace delete dialog this one mirrors. */
    const styles = `
.smp-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.smp-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.smp-unread{display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;flex:none}
`

    /** The one confirmation awaiting an answer, and the one notice on screen. */
    let pending = null
    let notice = null
    let sequence = 0
    const listeners = new Set()

    /** Publish a store change to every mounted outlet. */
    function publish() {
      for (const listener of listeners) listener()
    }

    /** Subscribe one outlet to the store. */
    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** Storage key for the Session ids this Client marks unread. */
    const UNREAD_KEY = 'dsh-session-menu-plus:unread'

    /**
     * Read the persisted unread set, ignoring a payload this plugin cannot parse.
     * @returns the stored ids, or an empty set.
     */
    function loadUnread() {
      try {
        const raw = window.localStorage.getItem(UNREAD_KEY)
        if (raw === null) return new Set()
        const parsed = JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [])
      } catch {
        return new Set()
      }
    }

    /** Session ids marked unread. Replaced on every write so snapshots stay comparable. */
    let unread = loadUnread()

    /**
     * Persist the unread set and publish it to every mounted outlet.
     * @param next - the set to keep.
     */
    function writeUnread(next) {
      unread = next
      try {
        window.localStorage.setItem(UNREAD_KEY, JSON.stringify([...next]))
      } catch {
        // A Client whose storage is full or blocked still gets the in-memory mark.
      }
      publish()
    }

    // Another window sharing this storage keeps the same marks.
    window.addEventListener('storage', (event) => {
      if (event.key !== UNREAD_KEY) return
      unread = loadUnread()
      publish()
    })

    const usePending = () => React.useSyncExternalStore(subscribe, () => pending)
    const useNotice = () => React.useSyncExternalStore(subscribe, () => notice)
    const useUnread = () => React.useSyncExternalStore(subscribe, () => unread)

    /** Show one notice; a new key restarts the banner. */
    function notify(text, success) {
      notice = { id: ++sequence, text, success }
      publish()
    }

    /**
     * Ask the Host to delete one idle Session.
     * @param sessionId - stored Session identity.
     * @returns the Host outcome, or a failed one when the route did not answer.
     */
    async function requestDelete(sessionId) {
      try {
        const response = await fetch('/session-menu-plus/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        return await response.json()
      } catch {
        return { ok: false, code: 'failed' }
      }
    }

    /**
     * Ask the Host for one Session's Markdown export.
     * @param sessionId - stored Session identity.
     * @returns the payload, or a failed outcome when the route did not answer.
     */
    async function requestExport(sessionId) {
      try {
        const response = await fetch('/session-menu-plus/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        return await response.json()
      } catch {
        return { ok: false, code: 'failed' }
      }
    }

    /**
     * Hand one text payload to the browser as a download; the browser owns the destination.
     * @param content - file text.
     * @param filename - name the browser suggests.
     * @param mediaType - media type the browser records.
     */
    function saveText(content, filename, mediaType) {
      const url = URL.createObjectURL(new Blob([content], { type: `${mediaType};charset=utf-8` }))
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.rel = 'noopener'
      anchor.click()
      URL.revokeObjectURL(url)
    }

    /**
     * Ask the Host for the Markdown export and save it, reporting through the notice seat.
     * @param sessionId - Session to export.
     * @param t - localized lookup for this plugin's namespace.
     */
    function exportNow(sessionId, t) {
      void requestExport(sessionId).then((result) => {
        if (result.ok) {
          saveText(result.content, result.filename, result.mediaType)
          notify(t('toast.exported'), true)
          return
        }
        notify(t(result.code === 'missing' ? 'toast.missing' : 'toast.exportFailed'), false)
      })
    }

    /**
     * Row mark (leading cell): the unread dot for a Session this Client marked unread.
     *
     * The row offers this 16px cell to the seat only while its own state is idle,
     * so the dot never competes with a running or pending status marker.
     * @param props - slot owner props.
     */
    function UnreadMark({ sessionId, t }) {
      const marked = useUnread()
      if (marked.has(sessionId) === false) return null
      return React.createElement('span', {
        className: 'smp-unread',
        role: 'img',
        'aria-label': t('unread.mark'),
      }, React.createElement(StateDot, { state: 'done' }))
    }

    /**
     * Menu row (order 440): flips this Session between read and unread.
     * @param props - slot owner props.
     */
    function MarkUnreadMenuItem({ sessionId, useMenuOpenState, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const marked = useUnread()
      const isUnread = marked.has(sessionId)
      return React.createElement(MenuItemButton, {
        icon: React.createElement(
          isUnread ? IconCheckCircleOutlineRegular : IconCheckCircleFillRegular,
          { size: 14 },
        ),
        onSelect: () => {
          setMenuOpen(false)
          const next = new Set(unread)
          if (isUnread) next.delete(sessionId)
          else next.add(sessionId)
          writeUnread(next)
        },
      }, t(isUnread ? 'menu.markRead' : 'menu.markUnread'))
    }

    /**
     * Menu row (order 460): writes this Session out as Markdown.
     * @param props - slot owner props.
     */
    function ExportMenuItem({ sessionId, useMenuOpenState, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return React.createElement(MenuItemButton, {
        icon: React.createElement(IconDownloadOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          exportNow(sessionId, t)
        },
      }, t('menu.exportMarkdown'))
    }

    /** Menu row (order 500): the destructive action that raises the confirmation. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return React.createElement(MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          pending = { sessionId, displayTitle }
          publish()
        },
      }, t('menu.deleteSession'))
    }

    /** `shell.overlay` entry: the confirmation for the Session awaiting an answer. */
    function DeleteSessionDialog({ t }) {
      const target = usePending()
      if (target === null) return null
      return React.createElement(DeleteSessionForm, { key: target.sessionId, target, t })
    }

    /** One confirmation's dialog: its in-flight state dies with it. */
    function DeleteSessionForm({ target, t }) {
      const [deleting, setDeleting] = React.useState(false)
      const close = () => {
        if (deleting) return
        pending = null
        publish()
      }
      const confirm = () => {
        setDeleting(true)
        void requestDelete(target.sessionId).then((result) => {
          pending = null
          if (result.ok) {
            notify(t('toast.deleted'), true)
            // The Host withdrew the row through `api-session/removed`; pull the
            // catalog as well so a Session the Host still had live cannot linger.
            try {
              void ctx.get('sessions')?.refresh?.()
            } catch {
              // A Host without the client session service still drops the row.
            }
            return
          }
          notify(t(result.code === 'missing'
            ? 'toast.missing'
            : result.code === 'running' ? 'toast.running' : 'toast.deleteFailed'), false)
        })
      }
      return React.createElement(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('close'),
        title: t('delete.confirm.title'),
        description: t('delete.confirm.desc', { title: target.displayTitle || t('session.untitled') }),
        footer: React.createElement(React.Fragment, null,
          React.createElement(Button, { variant: 'outline', disabled: deleting, onClick: close }, t('cancel')),
          React.createElement(Button, {
            variant: 'outline', className: 'smp-danger', disabled: deleting, onClick: confirm,
          }, t('delete.confirm.action'))),
      }, deleting === false
        ? null
        : React.createElement('div', { className: 'smp-status', role: 'status' }, t('delete.confirm.pending')))
    }

    /** `shell.overlay` entry: the one notice on screen. */
    function SessionMenuNotice() {
      const current = useNotice()
      if (current === null) return null
      return React.createElement(Toast, {
        key: current.id,
        text: current.text,
        tone: current.success ? 'success' : undefined,
        holdMs: 6000,
        onDone: () => {
          if (notice?.id !== current.id) return
          notice = null
          publish()
        },
      })
    }

    const inject = ['slots', 'locale']

    /** @param ctx - Client context owning slots, locale, and the browser document. */
    function apply(ctx) {
      ctx.effect(() => {
        const disposeZh = ctx.locale.register(NS, 'zh', zh)
        const disposeEn = ctx.locale.register(NS, 'en', en)
        return () => {
          disposeZh()
          disposeEn()
        }
      }, 'dsh-session-menu-plus: locale')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-session-menu-plus'
        style.textContent = styles
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-session-menu-plus: styles')

      // The covered gesture: a right-click anywhere on a Session row opens that
      // row's existing More menu through its own trigger, so the shipped rows,
      // focus return, and dismissal all stay the browser's.
      ctx.effect(() => {
        /** @param event - one document-level context-menu gesture. */
        const openMenu = (event) => {
          if (event.defaultPrevented) return
          const node = event.target
          if (!(node instanceof Element)) return
          const trigger = node.closest('[data-row-key^="session:"]')?.querySelector('button')
          if (trigger == null) return
          event.preventDefault()
          trigger.click()
        }
        document.addEventListener('contextmenu', openMenu)
        return () => { document.removeEventListener('contextmenu', openMenu) }
      }, 'dsh-session-menu-plus: right-click')

      ctx.slots.inject('shell.overlay', () => [
        ctx.slots.register({ name: 'shell.overlay', id: 'session-menu-plus-dialog', order: 100, locale: NS }, DeleteSessionDialog),
        ctx.slots.register({ name: 'shell.overlay', id: 'session-menu-plus-notice', order: 110 }, SessionMenuNotice),
      ])

      ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
        name: 'sidebar.session.row.leading',
        id: 'session-menu-plus.unread',
        order: 20,
        locale: NS,
      }, UnreadMark))

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-menu-plus.unread',
        order: 50,
        locale: NS,
      }, MarkUnreadMenuItem))

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-menu-plus.export',
        order: 460,
        locale: NS,
      }, ExportMenuItem))

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-menu-plus.delete',
        order: 500,
        locale: NS,
      }, DeleteSessionMenuItem))
    }

    return { inject, apply }
  },
})
