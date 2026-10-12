# Chestnut 🌰

个人 self-hosted 多 Bot 工作平台的第一版控制面基线。Bot 负责接收、排队和显示状态，独立 Worker 在隔离环境中运行 Pi。

**持久可写 Root 环境的实验后端已实现并通过模拟生命周期测试；真实 VPS 验收、受控在线安装和后台服务连续运行尚未完成，不能视为完整平台已完成。** 默认仍是只读 OS 的受限后端。实验后端见 [docs/persistent-backend.md](docs/persistent-backend.md)，后续验收见 [docs/persistent-bot-next.md](docs/persistent-bot-next.md)。

这是第一版源码，尚未部署或连接真实模型。Pi 的完整官方源码已纳入 `vendor/pi/`，固定到 `4270522473e677ddba7b093caa0064a3df51d459`，不是换个名字调用 registry SDK。Dashboard 是无需构建的原生 JavaScript 客户端。本机 macOS 已完成无模型演示、Unix socket 集成和 Safari 桌面基本交互验收；真实执行后端仍以 Linux 为目标，验证边界见 [docs/verification.md](docs/verification.md)。

## 先运行演示

需要 Node.js 24+。演示使用明确标注的确定性 FakeAdapter，没有 AI、Shell、模型计费或容器执行。

```sh
npm ci --ignore-scripts
npm run demo       # 无需浏览器/端口，真实 SQLite + 独立 Worker 进程
npm run dev        # API 与 Worker 两个进程
# 打开 http://127.0.0.1:4310
```

Dashboard 支持创建/选择 Bot、任务提交、历史与结果、进度事件、Steer、Follow-up、Cancel。默认端口 4310，仅允许 loopback。V1 没有登录/多人权限，不支持直接暴露到公网。

### 长期记忆

选择 Bot 后打开 **Memory** 页签，可以保存偏好、纠正、决策和经验，搜索、修改或忘记笔记，并查看 Git 修改历史。`All my bots` 在当前用户的 Bot 间共享；`Only this bot` 仅对当前 Bot 可见；`This project` 需要先绑定项目 slug，共用该 slug 的 Bot 可读取项目记忆。全局开关停止所有 Bot 的记忆读写，已有数据保留。

记忆保存在数据目录的 `control/memory/` 独立本地 Git 仓库，不配置远端。每个 Task 自动读取固定版本的相关记忆，并在 Activity 与 **Memory used in this task** 显示实际加载/访问记录。Demo 仍使用 FakeAdapter，其结果只证明上下文传递，不代表真实模型理解或学习。

真实 Pi 通过平台提供的 `memory_search`、`memory_read`、`memory_save`、`memory_update`、`memory_forget` 工具访问本轮私有 broker；Git 和控制数据库不挂入容器。更新镜像时需要重新运行 `npm run pi:build`，已有实验持久容器的镜像/文件不能隐式替换。容器内 socket、真实模型使用这些工具和 VPS 行为仍需要 Linux 验收。

忘记会移除当前正文与索引，并阻止 Agent 用标准化后相同的内容重新保存；显式用户保存可以恢复。旧正文仍在 Git 历史中，自动维护另用来源时间屏障，跳过忘记前的旧任务；新任务中任意同义表达不在哈希抑制范围内。未提交的文件修改保持原状，平台暂停新的记忆写入并提示检查，不会自动覆盖。自动提炼和每日 Dreaming 已接到独立 Worker，自动条目仅属于来源 Bot，矛盾建议保留待核实。本版接口、来源和维护契约见 [记忆开发设计](docs/memory-design.md)。

`npm run api` 和 `npm run worker` 可以分别启动；`npm run doctor` 检查 SQLite、Rootless Docker 和模型配置。`npm run build` 是 TypeScript 校验，Node 24 直接执行可擦除类型的 TS，不需要应用转译产物。

## 真实 Pi 模式

在你自己的 Linux 主机上完成以下步骤。真实容器构建、模型调用和容器网关联调尚未执行；本机无模型 API 与浏览器检查不能代替这些验收。

1. 以专用普通 OS 账户安装、配置 Rootless Docker，并确认 `docker info` 的 SecurityOptions 包含 rootless，cgroup v2/systemd 及 CPU/内存/PID/swap 控制均可用。不是让 Worker 使用 rootful Docker socket。
2. 安装上游依赖并验证源码：

```sh
npm --prefix vendor/pi ci --ignore-scripts
node scripts/pi-verify-source.mjs
node scripts/pi-hydrate.mjs
node scripts/pi-check-resolutions.mjs
npm --prefix vendor/pi run build:offline
npm run pi:contracts
npm run pi:build
```

3. 参考 `.env.example`，设置 `CHESTNUT_MODE=pi`、新的短路径 `CHESTNUT_DATA_DIR` 和 `CHESTNUT_MODEL`。Demo 与 Pi 数据目录不可混用。镜像默认 `chestnut-pi:4270522473e6`。
4. 通过外层 Worker 环境/密钥管理器配置 `OPENAI_API_KEY`。目前只支持固定官方 OpenAI Chat Completions 路由、一个配置模型、文本和 function tools。
5. `npm run doctor` 后运行 `npm run dev`。API、Worker、Rootless Docker 需使用同一专用 OS 用户，以便访问 mode-0600 的网关 socket。

容器网络固定为 none。外层可信网关持有密钥，每次请求检查任务/lease；容器只挂载本次 Run 的 Unix socket，用无密钥 loopback relay 调用允许的模型。没有 Docker 时会拒绝执行，不会回退到宿主机运行 Agent Shell。API Key 不写入数据库、不注入容器。

Pi 的 source build、pin、license、真实源码测试及修改方式见 [docs/pi-source.md](docs/pi-source.md)。


### 实验性持久 Root profile

必须明确选择，且使用新的数据目录：

```sh
CHESTNUT_MODE=pi
CHESTNUT_SANDBOX_PROFILE=persistent
CHESTNUT_EXPERIMENTAL_PERSISTENT=1
CHESTNUT_NETWORK_POLICY=none
CHESTNUT_DATA_DIR=/home/you/chestnut-persistent
```

还需要 util-linux 的 `flock`。固定 Bot 容器会保留可写 rootfs，正常结束、取消和恢复均停止整个 Bot，不删除其 OS 文件。缺失/替换的已记录容器不会自动重建。外层 OS 锁和可信 Docker 控制进程防止旧 Worker 的延迟操作与新任务交叉；不确定操作会保留锁并要求人工检查。运行中的服务会被停止；在线软件安装仍被拒绝，不会偷偷改成普通 bridge 网络。此 profile 尚无真实 Docker/VPS 验收。

## 本版行为

- SQLite WAL：Bots、Tasks、Runs、Commands、Events、Approvals、Outbox、Worker 心跳和环境锁。
- API 先持久化再响应；同一 Bot 的 messageId + 同一 payload 幂等，不同 payload 返回 409。
- 重任务全局并发 1，控制/聊天提交仍由独立 API 响应。
- Steer 仅发给当前运行任务，按 Pi 的完整工具批次边界生效。ACK 只显示 `sent_unconfirmed`，不冒充已影响模型结果。
- Follow-up 是持久的新任务，等待前一任务明确结束，携带有限的前任务文字上下文。没有把 Pi 的内存队列当成持久任务账本。
- Cancel 关闭后续输入、取消排队的依赖任务、请求 Pi 多类 abort/clear queue，短暂等待后清理容器。已发生的副作用不会回滚。
- 只有 `agent_settled` 表示生命周期结束；还要检查最终模型错误、aborted、可信清理结果才能判定终态。
- Worker 崩溃/lease 失效/不明传输中断：标为 interrupted，不自动重复原任务或不确定命令，依赖任务取消。过期环境进入 quarantine，确认对应容器清理后才恢复调度。
- Dashboard 的 API/event 请求支持游标轮询和重试；所有任务文本通过文本节点显示。

更多状态、进程和边界设计见 [docs/architecture.md](docs/architecture.md)。

## 明确的限制

- 默认 profile 是每 Bot 持久 workspace + 每 Task 独立 Pi session，根文件系统只读且每 Run 重建。实验 persistent profile 保存每 Bot 的可写容器根文件系统，按 Task 执行，但每次任务结束会停止整个 Bot，保留文件而不保留运行中服务。两种 profile 都没有每 Task Git worktree或任意 apt/git/pip 在线安装能力。
- 没有通用网络出口、外部集成凭据、自动授权执行审批、DAG、Redis、Temporal 或多人权限。Approvals 表是保留结构，不能当成完整审批功能。
- 根容器工具不依靠自身 hook 自我审批。当前可用能力由外层固定挂载和模型网关限制；新增外部能力必须另做可信授权。
- Rootless + network-none 不是恶意代码的强隔离保证。启动前要求 CPU/内存/PID/swap 控制，但实际执行仍待 VPS 验证；workspace/session 和持久容器可写层没有应用管理的磁盘配额，可能占满磁盘。请用专用账户和独立、有限额的数据卷；不要挂载自己的敏感目录。
- 模型网关限制单请求大小、输出 token、并发和超时，但没有总金额/总 token 预算；允许的模型能力仍可能产生费用。V1 不适合把模型能力交给不可信租户。
- 没有 exactly-once 外部副作用保证；中断后需人工查看实际文件/外部结果，再明确提交新任务。
- 任务/模型输出和 session 会保存在本机。不要在任务里输入你不希望模型提供方看到的秘密。

## 验证

```sh
npm run check       # 本项目 typecheck + 控制面/Worker/Gateway/适配层/UI 控制器测试
npm run pi:contracts # 真实 vendor Pi 的选定 session/queue/tool 测试
```

测试分为：确定性假适配器、内存 HTTP parser/handler、真实 vendor Pi import/build/source contracts。它们都不能替代真实模型、Rootless Docker、Unix socket、HTTP listener 或浏览器视觉测试。具体已运行和未运行项目见 [docs/verification.md](docs/verification.md)。

## API 简例

```sh
curl -s http://127.0.0.1:4310/api/status
curl -s -H 'Content-Type: application/json' -d '{"name":"Chestnut"}' http://127.0.0.1:4310/api/bots
# 使用返回的 bot id 和一个 UUID messageId：
curl -s -H 'Content-Type: application/json' -d '{"messageId":"<uuid>","prompt":"整理这个 workspace"}' http://127.0.0.1:4310/api/bots/<bot-id>/tasks
```

`GET /api/bots/:botId/tasks`、`GET /api/bots/:botId/tasks/:taskId/events?after=0` 和 `POST .../:taskId/commands` 提供状态与控制；command body 为 `{messageId,type:'steer'|'follow_up'|'cancel',text?}`。所有 task IDs 均校验所属 Bot。

### 自动学习与 Dreaming

默认在任务结束后提炼长期记忆，并在使用后每天运行一次 Dreaming。Memory 面板显示状态、来源和待核实建议，Dream now 可显式排队。运行时的记忆和维护预算位于独立数据目录，不提交到此代码仓库。

- `CHESTNUT_MEMORY_AUTOMATIC=0`：关闭自动调度；显式 Dream now 仍可执行。Memory 全局关闭会同时停止所有维护。
- `CHESTNUT_MEMORY_DAILY_CALLS=24`：每日维护调用上限（1–200），另外限制每日 160000 字符输入、每次 30 秒和 2500 输出 token。
- Demo 不调用模型，只从明确“Remember:”或“记住：”中保留偏好。Pi 使用外层模型凭据做来源绑定的提炼。

完整存储、并发、忘记和维护契约见 [memory-design.md](docs/memory-design.md)。真实模型、跨容器 socket 和 Linux/VPS 运行仍需对应环境验收。

Linux CI 使用 Node 24、固定 Pi 源码和离线模型目录，运行 Pi 构建、选定源代码合约、Chestnut 完整检查及独立 Worker 演示。该流程验证 Linux 锁与 Unix socket 行为；容器 daemon、真实模型和 VPS 部署仍使用各自的实机验收。
