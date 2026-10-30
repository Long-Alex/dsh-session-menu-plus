# dsh-session-menu-plus

给 DeepSeek Harness 侧边栏会话列表加两件事：**右键弹出会话菜单**、**带二次确认的会话删除**。

## 行为

- 在侧边栏任意会话行上右键 → 打开该行原本的「⋯」菜单（不再是必须精确点中图标）。
- 菜单末尾新增 `Delete session`（危险色 + 垃圾桶图标，带上分隔线）。点击后弹确认框：`Delete this session?` + 会话标题提示 + `Cancel` / `Delete session`。
- 结果以 Toast 反馈：成功 `Session deleted`；失败按「正在运行 / 会话不存在 / 删除失败」提示。
- 唯一的拒绝条件是「该会话正在跑任务」；当前打开的那行也能删。
- 删除是彻底的：转录目录、投影缓存、spill、工作区成员、归档标记、注册表内存索引一起清掉，再发 `api-session/removed` 让客户端立即撤行。
- 菜单还提供 `Export as JSON`（下载图标）：把该会话的完整事件流下载成 `session-<uuid>.json`，成功 `Session exported`。

## 安装

```bash
dsh plugin add /path/to/dsh-session-menu-plus   # 或在 Harness 里用插件管理器安装该目录
```

安装后重启 Harness（客户端模块是打包加载的）即可看到效果。

## 导出格式

导出文件是「原样事件流」，不重排、不摘要，可逐条回放：

```json
{
  "format": "dsh-session-export/1",
  "exportedAt": "2026-10-30T13:05:00.000Z",
  "session": { "type": "session", "version": 4, "id": "session-…", "cwd": "…", "agentPreset": "cordis" },
  "events": [ { "type": "user/message", "seq": 11, "time": 1793361445097, "data": { "…": "…" } } ]
}
```

- `session` 是该会话不可变的 header，`events` 是按 `seq` 排好序的全部已提交事件（含 `tool/call`、`tool/result`、`step/*`、`turn/*`、`session/title` 等）。
- 导出前会先 `sessions.flush(实时实例)`，所以正在跑的会话导出的也是「到此刻为止已落盘」的完整内容。
- 读取走 `sessionPersistence.open(id, 'read')`，与后端存储完全一致；不读投影缓存。

## 实现要点

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
