# 方案二（精简版）：多 Chrome Profile + 轻量协调 实现多账号同时发布

## 1. 仓库调研结论

### 当前发布链路（单 Profile）

- 发布页 [publish.tsx](file:///workspace/src/tabs/publish.tsx#L559-L561) → `MULTIPOST_EXTENSION_PUBLISH_NOW` → 后台 [index.ts](file:///workspace/src/background/index.ts#L123-L166) → `createTabsForPlatforms(data)` ([common.ts](file:///workspace/src/sync/common.ts#L135-L202))
- 账号检测通过 `fetch()` 读取当前 Profile Cookie，结果存 `chrome.storage.local["multipost_account_info"]`
- 一个 Profile = 一套登录态，无法跨 Profile 操控 tab

### 精简思路

- **Profile 创建自动化**：提供脚本一键生成 N 个 Profile 的用户数据目录 + 启动命令，用户无需手动在 Chrome 里建 Profile
- **协调服务极简化**：只做 WebSocket 消息转发，不引入 HTTP/express
- **扩展改动最小化**：现有单 Profile 发布逻辑**完全不变**，只在外面包一层「协调路由」

---

## 2. 文件与模块

### 新增文件

| 路径 | 说明 |
|---|---|
| `coordinator/server.js` | 单文件 WebSocket 协调服务（仅用 `ws` 包，无其他依赖） |
| `coordinator/setup-profiles.js` | Profile 创建脚本：生成 user-data-dir + 各 Profile 启动命令 |
| `coordinator/package.json` | 仅 `ws` 一个依赖 |
| `src/background/services/coordinator.ts` | 扩展端 WS 客户端：连接、上报账号、接收发布任务 |

### 修改文件

| 路径 | 改动 |
|---|---|
| `package.json` | 增加 `coordinator` workspace + `dev:coordinator`、`setup:profiles` 脚本 |
| `pnpm-workspace.yaml` | 注册 `coordinator` |
| `src/background/index.ts` | 启动 coordinator 客户端；`PUBLISH_NOW` 在协调模式下分发任务 |
| `src/sync/common.ts` | `SyncDataPlatform` 增加 `accountId?: string` |
| `src/tabs/publish.tsx` | 协调模式下追加「选择账号」步骤（最小改动，不改现有平台勾选逻辑） |
| `package.json` manifest | `host_permissions` 增加 `http://localhost:*/*` |

---

## 3. 实施步骤

### 步骤 1：Profile 创建脚本（`coordinator/setup-profiles.js`）

**解决「多 Profile 配置太麻烦」的核心**。

用户只需运行一次：
```bash
node coordinator/setup-profiles.js --accounts 3
```

脚本自动完成：
1. 在 `~/.multipost-profiles/` 下创建 `profile-1`、`profile-2`、`profile-3` 三个 `user-data-dir`
2. 生成 `~/.multipost-profiles/start-all.sh`（或 `.bat`），内容为三条命令，每条用不同 `--user-data-dir` 启动 Chrome 并加载扩展：
   ```bash
   google-chrome --user-data-dir=~/.multipost-profiles/profile-1 --load-extension=/path/to/build/chrome-mv3-dev &
   google-chrome --user-data-dir=~/.multipost-profiles/profile-2 --load-extension=/path/to/build/chrome-mv3-dev &
   ...
   ```
3. 打印使用说明：运行 `start-all.sh` → 在每个 Chrome 窗口里登录对应账号

> 用户后续只需双击 `start-all.sh` 即可启动所有 Profile。

### 步骤 2：轻量协调服务（`coordinator/server.js`，仅 WebSocket）

不引入 express，纯 `ws`：

```
端口 8787
├── 扩展连接时收到 REGISTER { profileId, accounts } → 存入内存 Map
├── 收到任意连接的 GET_ACCOUNTS → 广播所有 Profile 的账号合并列表
└── 收到 PUBLISH { taskId, platforms } → 按 accountId 拆分，通过对应 Profile 的 ws 下发 PUBLISH_TASK
```

- 内存数据结构：`Map<profileId, { ws, accounts: AccountInfo[] }>`
- 任务路由：遍历 `platforms`，按 `accountId` 查 `accounts` 找到 `profileId`，分组后下发
- 结果聚合：各 Profile 回发 `PUBLISH_RESULT`，协调服务收集齐后回传给发起方

### 步骤 3：扩展端协调客户端（`src/background/services/coordinator.ts`）

- 启动时从 storage 读 `coordinatorUrl`（默认 `ws://localhost:8787`）和 `profileId`（无则生成）
- WebSocket 连接 → 发 `REGISTER`（携带 `getAllAccountInfo()`）
- 监听消息：
  - `PUBLISH_TASK` → 调用**现有** `createTabsForPlatforms` + `addTabsManagerMessages` 执行 → 回发 `PUBLISH_RESULT`
- 账号刷新后发 `ACCOUNT_UPDATE`
- 断线重连（指数退避）

### 步骤 4：后台路由改造（`src/background/index.ts`）

```
PUBLISH_NOW 收到 syncData:
  if coordinator.connected && syncData.platforms.some(p => p.accountId):
      → 通过 coordinator 分发（POST-like 消息给协调服务）
  else:
      → 走原有的 createTabsForPlatforms（单 Profile 兼容）
```

### 步骤 5：数据结构（`src/sync/common.ts`）

`SyncDataPlatform` 增加可选字段：
```ts
accountId?: string;  // 协调模式下指定发布到哪个账号
```

`createTabsForPlatforms` **不改动**——协调服务已经把 platforms 按 Profile 拆好了。

### 步骤 6：发布页最小改动（`src/tabs/publish.tsx`）

- 协调模式下，在现有平台勾选列表下方，为每个被选平台展示一个「账号选择」下拉（来自协调服务的账号列表）
- 提交时把选中的 `accountId` 填入 `syncData.platforms[i].accountId`
- 发布状态展示增加账号维度

> 非协调模式下，这部分 UI 不渲染，完全走原逻辑。

### 步骤 7：配置

- `pnpm-workspace.yaml` 加 `coordinator`
- 根 `package.json` scripts：
  ```json
  "dev:coordinator": "node coordinator/server.js",
  "setup:profiles": "node coordinator/setup-profiles.js"
  ```

---

## 4. 依赖与注意事项

- 协调服务只有一个依赖 `ws`，体积小、启动快
- 扩展 `host_permissions` 需加 `http://localhost:*/*` 以允许 service worker 连本地 WS
- MV3 service worker 休眠问题：已有 `QuantumEntanglementKeepAlive` 保活；WS 消息到达会唤醒 worker
- Profile 间通过 `profileId`（UUID）区分，`chrome.runtime.id` 在所有 Profile 中相同
- 登录态留在各 Profile 本地，协调服务**不存任何 Cookie/密码**，只存账号元数据映射

---

## 5. 验证

1. **单 Profile 回归**：不启动协调服务 → 扩展正常单 Profile 发布（向后兼容）
2. **一键建 Profile**：`setup-profiles.js --accounts 2` 生成两个目录 + start-all.sh
3. **双 Profile 发布**：
   - 启动协调服务 + start-all.sh
   - Profile 1 登小红书账号 A，Profile 2 登小红书账号 B
   - 发布页勾选小红书，分别选账号 A 和 B，发布
   - 验证两个 Profile 各自打开小红书发布页并注入内容
4. **账号聚合**：协调服务返回两个 Profile 的账号列表
5. **断线重连**：重启协调服务后扩展自动重连并重新上报账号

---

## 6. 风险与应对

| 风险 | 应对 |
|---|---|
| 用户仍觉得多 Profile 麻烦 | setup 脚本已自动化；后续可把 start-all.sh 做成可双击的应用 |
| service worker 休眠丢 WS 消息 | 保活机制 + 重连重注册；任务下发时 fetch 唤醒 |
| 平台登录态过期 | 各 Profile 手动重登；协调服务检测到 `accountInfo` 为空则标记离线 |
| 改动影响现有用户 | 所有新逻辑由 `coordinator.connected` 开关控制，未连接时完全走原路径 |
