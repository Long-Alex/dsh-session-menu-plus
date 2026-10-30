/**
 * Client half: the Session menu opens on right-click, one destructive row there
 * deletes that Session behind a confirmation dialog, and this plugin adds its
 * own file and directory rows to the shared file context menu.
 *
 * The menu itself, its rows, and its keyboard walk belong to the workspace
 * browser; this plugin only adds rows through the seats the browser declares
 * and routes the covered gesture onto the browser's own More trigger. Dialogs,
 * notices, and their styling come from the shared Client primitives, so they
 * match the rest of the application.
 *
 * One browser script is served per plugin (`/plugins/<id>/client.js`), so the
 * file-menu block below lives in this factory instead of a sibling module; the
 * `fileMenu` export is its test seam and nothing else reads it.
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
      'file.menu.openTerminal': '在终端中打开',
      'file.menu.createFile': '新建文件',
      'file.menu.createFolder': '新建文件夹',
      'file.menu.rename': '重命名…',
      'file.menu.cut': '剪切',
      'file.menu.copy': '复制',
      'file.menu.paste': '粘贴',
      'file.menu.remove': '删除',
      'file.menu.copyRelativePath': '复制相对路径',
      'file.menu.addToChat': '添加到对话',
      'file.menu.viewChanges': '查看变更',
      'file.dialog.create.title': '新建文件',
      'file.dialog.mkdir.title': '新建文件夹',
      'file.dialog.rename.title': '重命名',
      'file.dialog.remove.title': '删除此项目？',
      'file.dialog.name.label': '名称',
      'file.dialog.name.desc': '名称只占一段路径，不能包含“/”或“\\”。',
      'file.dialog.rename.desc': '改名后扩展名保持不变。',
      'file.dialog.remove.desc': '“{name}”将被永久删除，无法恢复。',
      'file.dialog.create.action': '创建',
      'file.dialog.rename.action': '重命名',
      'file.dialog.remove.action': '删除',
      'file.dialog.pending': '正在处理…',
      'file.toast.terminalOpened': '已在终端中打开',
      'file.toast.created': '已创建“{name}”',
      'file.toast.renamed': '已重命名为“{name}”',
      'file.toast.removed': '已删除“{name}”',
      'file.toast.pasted': '已粘贴',
      'file.toast.cut': '已剪切“{name}”',
      'file.toast.copied': '已复制“{name}”',
      'file.toast.relativePathCopied': '已复制相对路径',
      'file.toast.mentionInserted': '已添加到对话',
      'file.toast.mentionCopied': '已复制 @ 引用',
      'file.toast.mentionFailed': '无法插入对话，请手动输入 @ 引用',
      'file.error.terminal': '无法打开终端',
      'file.error.changes': '无法打开变更视图',
      'file.error.mention': '无法添加到对话',
      'file.error.clipboard': '无法写入剪贴板',
      'file.error.notFound': '文件或文件夹已不存在',
      'file.error.exists': '同名项目已存在',
      'file.error.invalidName': '名称无效',
      'file.error.outside': '路径不在工作区内',
      'file.error.busy': '文件正忙，请稍后重试',
      'file.error.failed': '操作失败，请稍后重试',
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
      'file.menu.openTerminal': 'Open in terminal',
      'file.menu.createFile': 'New file',
      'file.menu.createFolder': 'New folder',
      'file.menu.rename': 'Rename…',
      'file.menu.cut': 'Cut',
      'file.menu.copy': 'Copy',
      'file.menu.paste': 'Paste',
      'file.menu.remove': 'Delete',
      'file.menu.copyRelativePath': 'Copy relative path',
      'file.menu.addToChat': 'Add to chat',
      'file.menu.viewChanges': 'View changes',
      'file.dialog.create.title': 'New file',
      'file.dialog.mkdir.title': 'New folder',
      'file.dialog.rename.title': 'Rename',
      'file.dialog.remove.title': 'Delete this item?',
      'file.dialog.name.label': 'Name',
      'file.dialog.name.desc': 'A name is one path segment and cannot contain “/” or “\\”.',
      'file.dialog.rename.desc': 'The extension is kept when the new name has none.',
      'file.dialog.remove.desc': '“{name}” will be deleted permanently. This cannot be undone.',
      'file.dialog.create.action': 'Create',
      'file.dialog.rename.action': 'Rename',
      'file.dialog.remove.action': 'Delete',
      'file.dialog.pending': 'Working…',
      'file.toast.terminalOpened': 'Opened in the terminal',
      'file.toast.created': 'Created “{name}”',
      'file.toast.renamed': 'Renamed to “{name}”',
      'file.toast.removed': 'Deleted “{name}”',
      'file.toast.pasted': 'Pasted',
      'file.toast.cut': 'Cut “{name}”',
      'file.toast.copied': 'Copied “{name}”',
      'file.toast.relativePathCopied': 'Relative path copied',
      'file.toast.mentionInserted': 'Added to the conversation',
      'file.toast.mentionCopied': 'Copied the @ reference',
      'file.toast.mentionFailed': 'Could not add it to the conversation. Type the @ reference instead',
      'file.error.terminal': 'Could not open a terminal',
      'file.error.changes': 'Could not open the changes view',
      'file.error.mention': 'Could not add it to the conversation',
      'file.error.clipboard': 'Could not write to the clipboard',
      'file.error.notFound': 'That file or folder no longer exists',
      'file.error.exists': 'Something with that name already exists',
      'file.error.invalidName': 'That name is not valid',
      'file.error.outside': 'That path is outside the workspace',
      'file.error.busy': 'The file is busy. Try again',
      'file.error.failed': 'That did not work. Try again',
    }

    /** Host routes this module calls; their bodies belong to the plugin's Host half. */
    const FILE_MENU_ROUTES = {
      create: '/session-menu-plus/fs/create',
      mkdir: '/session-menu-plus/fs/mkdir',
      rename: '/session-menu-plus/fs/rename',
      paste: '/session-menu-plus/fs/paste',
      remove: '/session-menu-plus/fs/remove',
      terminal: '/session-menu-plus/open-terminal',
    }

    /**
     * Where the Host answers which turn last changed one file. The review tab is
     * addressed by `sessionId + seq + turn` and only the Host can resolve those, so
     * this module asks instead of guessing a sequence.
     */
    const CHANGES_LOCATE_ROUTE = '/session-menu-plus/changes/locate'

    /** Resource-address prefix the `changes-review` tab type claims. */
    const CHANGES_REVIEW_ADDRESS = 'dsh-resource://changes-review/session/'

    /** Leading glyph of one file reference in a draft; the grammar's own token. */
    const MENTION = '@'

    /**
     * Register every file and directory row this plugin contributes.
     *
     * Called once from the plugin's `apply`. Contributions, icon renderers, and the
     * dialog overlay register through `ctx.effect` / `ctx.slots.inject`, so they
     * leave with the plugin fiber.
     * @param ctx - Client context carrying `contextMenus`, `slots`, `locale`, `sessions`, and `sidebarRight`.
     * @param t - localized lookup for this plugin's namespace (`session-menu-plus`).
     * @param load - the loader factory's synchronous `require`, for React and the icon atoms.
     */
    function registerFileMenu(ctx, t, load) {
      const React = load('react')
      const {
        Button, IconCodeOutlineRegular, IconCompareSplitOutlineRegular, IconCopyOutlineRegular,
        IconDragHandleOutlineRegular, IconEditOutlineRegular, IconLinkOutlineRegular, IconNewChatOutlineRegular,
        IconPlusOutlineRegular, IconProjectAddOutlineRegular, IconQueueOutlineRegular, IconTrashOutlineRegular,
        Input, Modal,
      } = load('@deepseek-ai/dsh-client-ui-primitives')

      /** Icon renderers by the key each action carries; the menu resolves one key at a time. */
      const icons = {
        'session-menu-plus.terminal': IconCodeOutlineRegular,
        'session-menu-plus.createFile': IconPlusOutlineRegular,
        'session-menu-plus.createFolder': IconProjectAddOutlineRegular,
        'session-menu-plus.rename': IconEditOutlineRegular,
        'session-menu-plus.cut': IconDragHandleOutlineRegular,
        'session-menu-plus.copy': IconCopyOutlineRegular,
        'session-menu-plus.paste': IconQueueOutlineRegular,
        'session-menu-plus.remove': IconTrashOutlineRegular,
        'session-menu-plus.copyRelativePath': IconLinkOutlineRegular,
        'session-menu-plus.addToChat': IconNewChatOutlineRegular,
        'session-menu-plus.viewChanges': IconCompareSplitOutlineRegular,
      }

      ctx.slots.inject('contextMenu.icon', function* () {
        for (const [key, Icon] of Object.entries(icons)) {
          yield ctx.slots.register({ name: 'contextMenu.icon', key }, Icon)
        }
      })

      /** Pending transfer for 剪切 / 复制, consumed by 粘贴; no Host call until then. */
      let clipboard = null

      /** The one dialog awaiting an answer, and the identity that resets its form. */
      let dialog = null
      let sequence = 0
      const listeners = new Set()

      /** Publish a dialog change to the mounted overlay entry. */
      function publish() {
        for (const listener of listeners) listener()
      }

      /** Subscribe one overlay entry to the dialog state. */
      function subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }

      const useDialog = () => React.useSyncExternalStore(subscribe, () => dialog)

      /** Show one notice through the shared menu feedback seat. */
      function notify(text, success) {
        ctx.contextMenus.notify(text, success)
      }

      /**
       * Open one dialog.
       * @param request - what the dialog asks for and which route answers it.
       */
      function showDialog(request) {
        dialog = { ...request, id: ++sequence }
        publish()
      }

      /** Dismiss the dialog on screen unless its request is still in flight. */
      function dismissDialog() {
        if (dialog === null) return
        dialog = null
        publish()
      }

      /**
       * Call one Host route and decode its JSON outcome.
       * @param route - one of {@link FILE_MENU_ROUTES}.
       * @param body - JSON request body.
       * @returns the decoded outcome, or a failed one when the route did not answer.
       */
      async function post(route, body) {
        try {
          const response = await fetch(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!response.ok) return { ok: false, code: 'failed' }
          const value = await response.json()
          return typeof value === 'object' && value !== null ? value : { ok: false, code: 'failed' }
        } catch {
          return { ok: false, code: 'failed' }
        }
      }

      /**
       * Localized text for one Host refusal code.
       * @param code - the refusal code the routes type.
       * @returns the sentence the notice shows.
       */
      function failureText(code) {
        switch (code) {
          case 'not-found': return t('file.error.notFound')
          case 'exists': return t('file.error.exists')
          case 'invalid-name': return t('file.error.invalidName')
          case 'outside-workspace': return t('file.error.outside')
          case 'busy': return t('file.error.busy')
          default: return t('file.error.failed')
        }
      }

      /**
       * One name segment the Host routes accept.
       * @param name - the raw input value.
       * @returns whether the Host would take it.
       */
      function validSegment(name) {
        if (name === '' || name === '.' || name === '..') return false
        if (/[/\\\u0000]/u.test(name)) return false
        return new TextEncoder().encode(name).length <= 255
      }

      /**
       * The parent directory of one workspace path; the workspace root for a
       * top-level entry.
       * @param path - workspace-relative file or directory path.
       * @returns its parent path, '' at the root.
       */
      function parentOf(path) {
        const cut = path.lastIndexOf('/')
        return cut < 0 ? '' : path.slice(0, cut)
      }

      /**
       * The basename of one workspace path, which the rename dialog prefills.
       * @param path - workspace-relative path.
       * @returns its last segment.
       */
      function baseNameOf(path) {
        return path.slice(path.lastIndexOf('/') + 1)
      }

      /** The Session the main view is showing, resolved the way the browser highlights a row. */
      function viewedSession() {
        return Object.values(ctx.sessions.list.getSnapshot().byId)
          .find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
      }

      /**
       * Ask the Host for the turn that last changed one file.
       * @param sessionId - owning Session.
       * @param path - workspace-relative file path.
       * @param signal - dismissal signal.
       * @returns the review coordinates, or null when no turn changed the file or the route is absent.
       */
      async function locateChange(sessionId, path, signal) {
        try {
          const response = await fetch(CHANGES_LOCATE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, path }),
            signal,
          })
          if (!response.ok) return null
          const value = await response.json()
          const { ok, seq, turn, index } = value ?? {}
          if (ok !== true || !Number.isSafeInteger(seq) || !Number.isSafeInteger(turn) || !Number.isSafeInteger(index)) return null
          return { seq, turn, index }
        } catch {
          return null
        }
      }

      /**
       * Open one turn's changed-file review on the addressed file.
       * @param sessionId - Session the review belongs to.
       * @param change - the review coordinates.
       */
      function openChangeReview(sessionId, change) {
        const address = `${CHANGES_REVIEW_ADDRESS}${encodeURIComponent(sessionId)}/${change.seq}/${change.turn}`
        ctx.sidebarRight.openResource(address, { params: { index: change.index } })
      }

      /**
       * Insert one `@workspace/path` reference into the composer, or copy it when
       * the composer cannot take the text.
       *
       * The trigger pipeline inserts a reference only from a `TokenSpan` carrying
       * the input machine's live `draftRev` (`ui-conversation` mints it inside the
       * editor), and `InputTriggerController.pick` needs an already-open menu. This
       * module therefore writes into the editor's own contenteditable the way a
       * paste does, which the editor's update listener re-tracks as ordinary draft
       * text, and verifies the result before claiming success.
       * @param path - workspace-relative file path.
       */
      function addToConversation(path) {
        const mention = `${MENTION}${path}`
        const spaceless = `${mention} `
        // Several panes can each hold a composer; the visible one is the target.
        const editors = [...document.querySelectorAll('[data-input-scroll] [data-composer-input]')]
        const editor = editors.find(node => node instanceof HTMLElement && node.isContentEditable && node.offsetParent !== null)
        if (editor !== undefined) {
          editor.focus()
          const selection = window.getSelection()
          if (selection !== null && selection.anchorNode !== null && editor.contains(selection.anchorNode) === false) {
            const range = document.createRange()
            range.selectNodeContents(editor)
            range.collapse(false)
            selection.removeAllRanges()
            selection.addRange(range)
          }
          try {
            if (document.execCommand('insertText', false, spaceless) && editor.textContent.includes(mention)) {
              notify(t('file.toast.mentionInserted'), true)
              return
            }
          } catch {
            // A Client without execCommand falls through to the clipboard reference.
          }
        }
        void navigator.clipboard.writeText(mention).then(
          () => { notify(t('file.toast.mentionCopied'), true) },
          () => { notify(t('file.toast.mentionFailed'), false) },
        )
      }

      /** Row: ask the Host to open its terminal at one directory. */
      function openTerminal(sessionId, directory) {
        void post(FILE_MENU_ROUTES.terminal, { sessionId, path: directory }).then((result) => {
          if (result.ok === true) {
            notify(t('file.toast.terminalOpened'), true)
            return
          }
          // The Host answers `busy` when no terminal launcher took the request.
          notify(result.code === 'busy' ? t('file.error.terminal') : failureText(result.code), false)
        })
      }

      /** Row: remember one cut/copy source, and clear it when a cut is pasted. */
      function rememberClipboard(sessionId, path, mode) {
        clipboard = { sessionId, path, mode }
        notify(mode === 'cut' ? t('file.toast.cut', { name: baseNameOf(path) }) : t('file.toast.copied', { name: baseNameOf(path) }), true)
      }

      /** Row: copy or move the remembered source into one directory. */
      function pasteInto(sessionId, directory) {
        if (clipboard === null) return
        const pending = clipboard
        void post(FILE_MENU_ROUTES.paste, {
          sessionId, path: directory, mode: pending.mode, source: pending.path,
        }).then((result) => {
          if (result.ok !== true) {
            notify(failureText(result.code), false)
            return
          }
          // A cut moves its source, so the same source cannot move twice.
          if (pending.mode === 'cut' && clipboard === pending) clipboard = null
          notify(t('file.toast.pasted'), true)
        })
      }

      /** Row: copy one workspace-relative path. */
      function copyRelativePath(path) {
        void navigator.clipboard.writeText(path).then(
          () => { notify(t('file.toast.relativePathCopied'), true) },
          () => { notify(t('file.error.clipboard'), false) },
        )
      }

      /**
       * The success sentence of one dialog request.
       * @param request - the answered dialog.
       * @param name - the accepted name.
       * @returns localized notice text.
       */
      function successText(request, name) {
        switch (request.kind) {
          case 'rename': return t('file.toast.renamed', { name })
          case 'remove': return t('file.toast.removed', { name: baseNameOf(request.path) })
          default: return t('file.toast.created', { name })
        }
      }

      /**
       * Submit one dialog request to its route.
       * @param request - the open dialog.
       * @param name - the trimmed input value (unused by remove).
       * @returns the notice text and whether the Host accepted the request.
       */
      async function submitRequest(request, name) {
        if (request.kind !== 'remove' && validSegment(name) === false) {
          return { ok: false, text: t('file.error.invalidName') }
        }
        const route = FILE_MENU_ROUTES[request.kind === 'remove' ? 'remove' : request.kind]
        const body = request.kind === 'remove'
          ? { sessionId: request.sessionId, path: request.path }
          : { sessionId: request.sessionId, path: request.path, name }
        const result = await post(route, body)
        return result.ok === true
          ? { ok: true, text: successText(request, name) }
          : { ok: false, text: failureText(result.code) }
      }

      /** `shell.overlay` entry: the file dialog on screen, if any. */
      function FileMenuDialog({ t: translate }) {
        const request = useDialog()
        if (request === null) return null
        return React.createElement(FileMenuDialogForm, { key: request.id, request, t: translate })
      }

      /** One dialog's form; its in-flight state dies with it. */
      function FileMenuDialogForm({ request, t: translate }) {
        const [name, setName] = React.useState(request.name ?? '')
        const [busy, setBusy] = React.useState(false)
        const close = () => {
          if (busy) return
          dismissDialog()
        }
        const submit = () => {
          if (busy) return
          setBusy(true)
          void submitRequest(request, name.trim()).then((outcome) => {
            dismissDialog()
            notify(outcome.text, outcome.ok)
          })
        }
        const wantsName = request.kind !== 'remove'
        const title = wantsName
          ? translate(request.kind === 'rename'
            ? 'file.dialog.rename.title'
            : request.kind === 'mkdir' ? 'file.dialog.mkdir.title' : 'file.dialog.create.title')
          : translate('file.dialog.remove.title')
        const action = translate(request.kind === 'rename'
          ? 'file.dialog.rename.action' : request.kind === 'remove' ? 'file.dialog.remove.action' : 'file.dialog.create.action')
        return React.createElement(Modal, {
          open: true,
          onClose: close,
          closeLabel: translate('close'),
          title,
          description: wantsName
            ? translate(request.kind === 'rename' ? 'file.dialog.rename.desc' : 'file.dialog.name.desc')
            : translate('file.dialog.remove.desc', { name: baseNameOf(request.path) }),
          footer: React.createElement(React.Fragment, null,
            React.createElement(Button, { variant: 'outline', disabled: busy, onClick: close }, translate('cancel')),
            React.createElement(Button, {
              variant: 'outline',
              ...(request.kind === 'remove' ? { className: 'smp-danger' } : {}),
              disabled: busy,
              onClick: submit,
            }, action)),
        }, wantsName
          ? React.createElement('form', {
            className: 'smp-file-field',
            onSubmit: (event) => {
              event.preventDefault()
              submit()
            },
          }, React.createElement('label', { className: 'smp-file-label', htmlFor: 'smp-file-name-input' },
            translate('file.dialog.name.label')),
          React.createElement(Input, {
            id: 'smp-file-name-input',
            value: name,
            autoFocus: true,
            spellCheck: false,
            autoComplete: 'off',
            'aria-label': translate('file.dialog.name.label'),
            onChange: event => setName(event.target.value),
          }))
          : busy
            ? React.createElement('div', { className: 'smp-status', role: 'status' }, translate('file.dialog.pending'))
            : null)
      }

      /** Styles this module adds: the name field layout and its label. */
      const styles = `
    .smp-file-field{display:flex;flex-direction:column;gap:8px}
    .smp-file-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
    `

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-session-menu-plus:file-menu'
        style.textContent = styles
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-session-menu-plus: file menu styles')

      ctx.slots.inject('shell.overlay', () => [
        ctx.slots.register({
          name: 'shell.overlay', id: 'session-menu-plus-file-dialog', order: 120, locale: 'session-menu-plus',
        }, FileMenuDialog),
      ])

      // Order 310: a terminal at this directory (a file's parent, since the
      // native terminal always starts at the Session working directory).
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.terminal', target: 'directory', order: 310,
        resolve: ({ sessionId, path }) => [{
          id: 'terminal',
          label: t('file.menu.openTerminal'),
          icon: { key: 'session-menu-plus.terminal' },
          failureLabel: t('file.error.terminal'),
          run: () => openTerminal(sessionId, path),
        }],
      }), 'session-menu-plus: directory terminal row')

      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.terminal', target: 'file', order: 310,
        resolve: ({ sessionId, path }) => [{
          id: 'terminal',
          label: t('file.menu.openTerminal'),
          icon: { key: 'session-menu-plus.terminal' },
          failureLabel: t('file.error.terminal'),
          run: () => openTerminal(sessionId, parentOf(path)),
        }],
      }), 'session-menu-plus: file terminal row')

      // Order 400 / 410: create an empty file or a directory in this one.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.create', target: 'directory', order: 400,
        resolve: ({ sessionId, path }) => [
          {
            id: 'createFile',
            label: t('file.menu.createFile'),
            icon: { key: 'session-menu-plus.createFile' },
            separatorBefore: true,
            run: () => { showDialog({ kind: 'create', sessionId, path, name: '' }) },
          },
          {
            id: 'createFolder',
            label: t('file.menu.createFolder'),
            icon: { key: 'session-menu-plus.createFolder' },
            run: () => { showDialog({ kind: 'mkdir', sessionId, path, name: '' }) },
          },
        ],
      }), 'session-menu-plus: directory create rows')

      // Order 500: rename in place, prefilled with the current basename.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.rename', target: 'file', order: 500,
        resolve: ({ sessionId, path }) => [{
          id: 'rename',
          label: t('file.menu.rename'),
          icon: { key: 'session-menu-plus.rename' },
          separatorBefore: true,
          run: () => { showDialog({ kind: 'rename', sessionId, path, name: baseNameOf(path) }) },
        }],
      }), 'session-menu-plus: file rename row')

      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.rename', target: 'directory', order: 500,
        resolve: ({ sessionId, path }) => [{
          id: 'rename',
          label: t('file.menu.rename'),
          icon: { key: 'session-menu-plus.rename' },
          run: () => { showDialog({ kind: 'rename', sessionId, path, name: baseNameOf(path) }) },
        }],
      }), 'session-menu-plus: directory rename row')

      // Order 510-540: the Client-side clipboard pair, then the destructive row.
      // 粘贴 exists only for a directory and only while the clipboard holds a
      // transfer; 删除 carries `danger` and no separator (the spec's separator
      // belongs to the row after it).
      const clipboardRows = (target) => [
        {
          id: 'cut',
          label: t('file.menu.cut'),
          icon: { key: 'session-menu-plus.cut' },
          run: () => { rememberClipboard(target.sessionId, target.path, 'cut') },
        },
        {
          id: 'copy',
          label: t('file.menu.copy'),
          icon: { key: 'session-menu-plus.copy' },
          run: () => { rememberClipboard(target.sessionId, target.path, 'copy') },
        },
        ...target.kind === 'directory' ? [{
          id: 'paste',
          label: t('file.menu.paste'),
          icon: { key: 'session-menu-plus.paste' },
          // The Host verifies a source inside the same Session workspace, so a
          // transfer remembered elsewhere is not pasteable here.
          disabled: clipboard === null || clipboard.sessionId !== target.sessionId,
          run: () => { pasteInto(target.sessionId, target.path) },
        }] : [],
        {
          id: 'remove',
          label: t('file.menu.remove'),
          icon: { key: 'session-menu-plus.remove' },
          danger: true,
          run: () => { showDialog({ kind: 'remove', sessionId: target.sessionId, path: target.path, name: '' }) },
        },
      ]
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.clipboard', target: 'file', order: 510,
        resolve: target => clipboardRows({ ...target, kind: 'file' }),
      }), 'session-menu-plus: file clipboard rows')
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.clipboard', target: 'directory', order: 510,
        resolve: target => clipboardRows({ ...target, kind: 'directory' }),
      }), 'session-menu-plus: directory clipboard rows')

      // Order 610: the workspace-relative path, distinct from the absolute path
      // `ui-open-in-app` already offers.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.relativePath', target: 'file', order: 610,
        resolve: ({ path }) => [{
          id: 'copyRelativePath',
          label: t('file.menu.copyRelativePath'),
          icon: { key: 'session-menu-plus.copyRelativePath' },
          separatorBefore: true,
          failureLabel: t('file.error.clipboard'),
          run: () => copyRelativePath(path),
        }],
      }), 'session-menu-plus: file relative path row')

      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.relativePath', target: 'directory', order: 610,
        resolve: ({ path }) => [{
          id: 'copyRelativePath',
          label: t('file.menu.copyRelativePath'),
          icon: { key: 'session-menu-plus.copyRelativePath' },
          separatorBefore: true,
          failureLabel: t('file.error.clipboard'),
          run: () => copyRelativePath(path),
        }],
      }), 'session-menu-plus: directory relative path row')

      // Order 700: put the file into the composer as an `@` reference.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.addToChat', target: 'file', order: 700,
        resolve: ({ path }) => [{
          id: 'addToChat',
          label: t('file.menu.addToChat'),
          icon: { key: 'session-menu-plus.addToChat' },
          separatorBefore: true,
          failureLabel: t('file.error.mention'),
          run: () => addToConversation(path),
        }],
      }), 'session-menu-plus: file add-to-chat row')

      // Order 710: this file's review tab. The Host resolves the turn that last
      // changed the file; without one there is nothing to review, so no row.
      ctx.effect(() => ctx.contextMenus.register({
        id: 'session-menu-plus.changes', target: 'file', order: 710,
        resolve: async ({ sessionId, path }, signal) => {
          const change = await locateChange(sessionId, path, signal)
          if (change === null || viewedSession() !== sessionId) return []
          return [{
            id: 'viewChanges',
            label: t('file.menu.viewChanges'),
            icon: { key: 'session-menu-plus.viewChanges' },
            failureLabel: t('file.error.changes'),
            run: () => { openChangeReview(sessionId, change) },
          }]
        },
      }), 'session-menu-plus: file changes row')
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

    const inject = ['slots', 'locale', 'sessions']

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

      // Reading a Session clears *its* mark, and only when that Session becomes
      // the one the main view holds. The id is resolved the same way the browser
      // resolves the highlighted row, so the two never disagree.
      ctx.effect(() => {
        const shown = () => Object.values(ctx.sessions.list.getSnapshot().byId)
          .find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
        let current = shown()
        const clearSwitch = () => {
          const next = shown()
          if (next === undefined || next === current) return
          current = next
          if (unread.has(next) === false) return
          const marked = new Set(unread)
          marked.delete(next)
          writeUnread(marked)
        }
        const stop = ctx.sessions.list.subscribe(clearSwitch)
        clearSwitch()
        return stop
      }, 'session-menu-plus: showing a Session clears its mark')

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

      // File and directory rows. `ctx.inject` keeps them waiting for the menu
      // capability alone: a Client that composes it out still gets the Session
      // rows above, and this block leaves with the same fiber.
      ctx.inject(['contextMenus', 'sidebarRight'], (child) => {
        registerFileMenu(child, ctx.locale.bind(NS), require)
      })
    }

    return {
      inject,
      apply,
      // Test seam for the inlined file menu: the browser check drives the
      // registration and dictionaries that ship here instead of a copy. The
      // Loader reads `inject` and `apply` and ignores this key.
      fileMenu: { registerFileMenu, zh, en },
    }
  },
})
