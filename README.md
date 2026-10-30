# dsh-session-menu-plus

给 DeepSeek Harness 侧边栏会话列表加两件事：**右键弹出会话菜单**、**带二次确认的会话删除**。

## 行为

- 在侧边栏任意会话行上右键 → 打开该行原本的「⋯」菜单（不再是必须精确点中图标）。
- 菜单末尾新增 `Delete session`（危险色 + 垃圾桶图标，带上分隔线）。点击后弹确认框：`Delete this session?` + 会话标题提示 + `Cancel` / `Delete session`。
- 结果以 Toast 反馈：成功 `Session deleted`；失败按「正在运行 / 会话不存在 / 删除失败」提示。
- 唯一的拒绝条件是「该会话正在跑任务」；当前打开的那行也能删。
- 删除是彻底的：转录目录、投影缓存、spill、工作区成员、归档标记、注册表内存索引一起清掉，再发 `api-session/removed` 让客户端立即撤行。
- 菜单里有一行 `Export`（下载图标，在 `Copy Session ID` 之后），点它会就地展开两项：`Export as Markdown` → `session-<uuid>.md`，`Export as JSON` → `session-<uuid>.json`，再点一次收起，成功 `Session exported`。

## 安装

```bash
dsh plugin add /path/to/dsh-session-menu-plus   # 或在 Harness 里用插件管理器安装该目录
```

安装后重启 Harness（客户端模块是打包加载的）即可看到效果。

## 导出格式

两种格式来自同一次读取，内容同源。

### JSON：原样事件流

不重排、不摘要，可逐条回放：

```json
{
  "format": "dsh-session-export/1",
  "exportedAt": "2026-10-30T13:05:00.000Z",
  "session": { "type": "session", "version": 4, "id": "session-…", "cwd": "…", "agentPreset": "cordis" },
  "events": [ { "type": "user/message", "seq": 11, "time": 1793361445097, "data": { "…": "…" } } ]
}
```

- `session` 是该会话不可变的 header，`events` 是按 `seq` 排好序的全部已提交事件（含 `tool/call`、`tool/result`、`step/*`、`turn/*`、`session/title` 等）。
### Markdown：给人读的转录

```markdown
# <会话标题>

- Session: `session-…`
- Working directory: `/Users/alex.long`
- Started: 2026-10-30T10:48:47.004Z
- Agent preset: `cordis`
- Exported: 2026-10-30T13:12:11.071Z

---

## Turn 1 · 2026-10-30T11:57:25.012Z

**User**

…

**Assistant**

…

**Tool · `bash`**

<details><summary>Arguments</summary>

```json
{"command":"ls"}
```

</details>

<details><summary>Result</summary>

```text
…
```

</details>
```

- 按 `turn/start` 分节；用户与助手正文取 `text` 块（`reasoning` 与 `tool-call` 块跳过，工具调用改从 `tool/call` / `tool/result` 成对渲染，参数与结果放在可折叠块里）。
- 单段参数或结果超过 4000 字符会截断并标注省略了多少字符；只有调用没有结果的，会写明 `No result was recorded.`。
- 代码块围栏会自动避开内容里自带的 ```，不会被内容提前闭合。

### 两种格式共同的前提

- 导出前会先 `sessions.flush(实时实例)`，所以正在跑的会话导出的也是「到此刻为止已落盘」的完整内容。
- 读取走 `sessionPersistence.open(id, 'read')`，与后端存储完全一致；不读投影缓存。
- JSON 用 `JSON.stringify(…, null, 2)`，Markdown 是纯文本，浏览器各自按 `application/json` / `text/markdown` 保存。

## 实现要点

- **导出的展开行（客户端）**：`Export` 与它展开的两个格式行都是内置 `MenuItemButton`，三者是同一个菜单里的兄弟行，不另开弹层。这是被平台约束逼出来的正确做法：会话菜单用 `closeOnPointerLeave` 打开，并裁切溢出，所以任何“浮在旁边的子卡片”都会在指针移入时把父菜单带走（portal 卡片）或被菜单容器裁掉（内联绝对定位）。展开行放在同一张菜单里，就只有一个指针目标、一套键盘走位，不会被裁，也不会互相关闭。
- **菜单行（客户端）**：`sidebar.workspaces.session.menu.item` 注入一行 `MenuItemButton`（危险色＋垃圾桶＋分隔线），点了先弹 `Modal` 确认，确认后 `POST /session-menu-plus/delete`；失败/成功都用共享 `Toast` 反馈。不写自定义弹窗、不改内置组件。
- **右键**：`contextmenu` 手势导向该行自己的「⋯」触发按钮，菜单、焦点、外部点击关闭、快捷键全部沿用内置实现。
- **宿主（删除步骤：全部走宿主自己的服务，不自己扫目录）**：
  1. `agents.get(id).status === 'running'` 才拒绝（唯一的拒绝条件）；
  2. `readHeader`：实时实例 → `sessionQuery.readSession` → `sessionPersistence.list`；
  3. 实时实例先 `sessions.flush()` 再 `detachEntered` 摘除，避免还有写手在往删掉的文件里追加；
  4. `sessionProjectionCache.delete(id)` 清投影缓存；
  5. `workspaceRegistry.unarchiveSession(id)` ＋ 从每个工作区 `detachSession(id)`；
  6. `sessionPersistence.locate(header)` 拿到转录路径 → 目录里只剩后端自己的文件（转录 + `session.lock`）时整目录删，否则只删转录；
  7. 删 `spillStore` 里对应目录；
  8. 清注册表内存索引（`headers/sessionPaths/missingSessionPaths/invalidSessionPaths`），防止陈旧列表把行重新编进来；
  9. `emit('api-session/removed')`，客户端顺手 `sessions.refresh()`。
- **宿主服务全部用 `ctx.get()` 取**，缺谁就降级跳过，不硬依赖；`webServer`/`connection` 走 `ctx.inject`。

## 已知限制

- 正在跑任务的会话会被拒绝删除，其余（含当前打开的那行）都能删。
- 删掉当前打开的会话后，右侧对话区会退回开场/登录页，会话目录与投影缓存都已消失。
- 会话删除后不会同步清理 `workspace.json` 中的 `sessionIds` / `archivedSessionIds` / `pinnedSessionIds`——平台目前没有对应的移除 API，残留条目不显示也不影响使用。

## 验证

`verification/` 下是真实运行截图：右键菜单、确认框、成功 Toast（同一行随后从列表消失）、以及删「正在打开的那一行」时的拒绝提示。
`tests/delete-route.test.js` 覆盖删除路由的成功 / in-use / missing / 非法请求四条分支：

```bash
node --test tests/
```
