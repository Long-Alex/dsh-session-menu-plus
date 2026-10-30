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
      Button, IconDownloadOutlineRegular, IconTrashOutlineRegular, Menu, MenuItemButton, Modal, Toast,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Dictionary namespace owned by this plugin. */
    const NS = 'session-menu-plus'

    /** Simplified Chinese dictionary. */
    const zh = {
      'menu.export': '导出',
      'menu.exportJson': '导出为 JSON',
      'menu.exportMarkdown': '导出为 Markdown',
      'menu.deleteSession': '删除会话',
      'delete.confirm.title': '删除此会话？',
      'delete.confirm.desc': '“{title}”的会话记录将从本机永久删除，无法恢复。',
      'delete.confirm.action': '删除会话',
      'delete.confirm.pending': '正在删除会话…',
      'toast.exported': '会话已导出',
      'toast.exportFailed': '导出失败，请稍后重试',
      'toast.deleted': '会话已删除',
      'toast.deleteFailed': '删除失败，请稍后重试',
      'toast.missing': '该会话已不存在',
      'toast.running': '该会话正在运行，等它结束后再删',
    }

    /** English dictionary. */
    const en = {
      'menu.export': 'Export',
      'menu.exportJson': 'Export as JSON',
      'menu.exportMarkdown': 'Export as Markdown',
      'menu.deleteSession': 'Delete session',
      'delete.confirm.title': 'Delete this session?',
      'delete.confirm.desc': '“{title}” will be deleted from this device permanently. This cannot be undone.',
      'delete.confirm.action': 'Delete session',
      'delete.confirm.pending': 'Deleting session…',
      'toast.exported': 'Session exported',
      'toast.exportFailed': 'Could not export the session. Try again',
      'toast.deleted': 'Session deleted',
      'toast.deleteFailed': 'Could not delete the session. Try again',
      'toast.missing': 'That session no longer exists',
      'toast.running': 'That session is running. Delete it once it settles',
    }

    /** Row styling the shared primitives do not carry: the destructive confirm label and its pending line. */
    const styles = `
.smp-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.smp-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
`

    /** The one confirmation awaiting an answer, the open Export submenu, and the notice on screen. */
    let pending = null
    let submenu = null
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

    const usePending = () => React.useSyncExternalStore(subscribe, () => pending)
    const useSubmenu = () => React.useSyncExternalStore(subscribe, () => submenu)
    const useNotice = () => React.useSyncExternalStore(subscribe, () => notice)

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
     * Ask the Host for one Session's export in the requested format.
     * @param sessionId - stored Session identity.
     * @param format - `json` or `markdown`.
     * @returns the payload, or a failed outcome when the route did not answer.
     */
    async function requestExport(sessionId, format) {
      try {
        const response = await fetch('/session-menu-plus/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, format }),
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
     * Ask the Host for one export and save it, reporting through the notice seat.
     * @param sessionId - Session to export.
     * @param format - `markdown` or `json`.
     * @param t - localized lookup for this plugin's namespace.
     */
    function exportNow(sessionId, format, t) {
      void requestExport(sessionId, format).then((result) => {
        if (result.ok) {
          saveText(result.content, result.filename, result.mediaType)
          notify(t('toast.exported'), true)
          return
        }
        notify(t(result.code === 'missing' ? 'toast.missing' : 'toast.exportFailed'), false)
      })
    }

    /**
     * Remember where a menu row sits so a nested menu can open under it.
     * @param event - one pointer gesture inside the popup.
     */
    function rememberRow(event) {
      const row = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null
      if (row === null) return
      submenuRect = row.getBoundingClientRect()
    }

    /** The row that raised the submenu currently opening, and that row's box. */
    let submenuRect = null

    /**
     * Parent row (order 460): opens the two-format submenu below itself. The
     * nested popup is the shared `Menu`, so its styling and keyboard walk match.
     * @param props - slot owner props.
     */
    function ExportMenuItem({ sessionId, useMenuOpenState, t }) {
      const [menuOpen] = useMenuOpenState()
      // The submenu lives under this row and dies with the menu that owns it.
      React.useEffect(() => {
        if (menuOpen === false && submenu !== null) {
          submenu = null
          publish()
        }
      }, [menuOpen])
      return React.createElement(MenuItemButton, {
        icon: React.createElement(IconDownloadOutlineRegular, { size: 14 }),
        onSelect: () => {
          submenu = { sessionId, rect: submenuRect, t }
          publish()
        },
      }, t('menu.export'))
    }

    /** `shell.overlay` entry: the Export submenu, anchored under the row that opened it. */
    function ExportSubmenu() {
      const current = useSubmenu()
      if (current === null) return null
      const close = () => {
        submenu = null
        publish()
      }
      return React.createElement(Menu, {
        open: true,
        portal: true,
        anchor: null,
        getAnchorRect: () => current.rect,
        align: 'start',
        side: 'right',
        compact: true,
        autoFocus: true,
        items: [
          { id: 'markdown', label: current.t('menu.exportMarkdown') },
          { id: 'json', label: current.t('menu.exportJson') },
        ],
        onSelect: (id) => {
          const { sessionId, t } = current
          close()
          exportNow(sessionId, id === 'json' ? 'json' : 'markdown', t)
        },
        onClose: close,
      })
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
        document.addEventListener('pointerdown', rememberRow, true)
        return () => {
          document.removeEventListener('contextmenu', openMenu)
          document.removeEventListener('pointerdown', rememberRow, true)
        }
      }, 'dsh-session-menu-plus: right-click')

      ctx.slots.inject('shell.overlay', () => [
        ctx.slots.register({ name: 'shell.overlay', id: 'session-menu-plus-dialog', order: 100, locale: NS }, DeleteSessionDialog),
        ctx.slots.register({ name: 'shell.overlay', id: 'session-menu-plus-submenu', order: 105 }, ExportSubmenu),
        ctx.slots.register({ name: 'shell.overlay', id: 'session-menu-plus-notice', order: 110 }, SessionMenuNotice),
      ])

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
