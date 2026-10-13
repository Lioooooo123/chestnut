# Chestnut 🌰

个人 self-hosted 多 Bot 工作平台，当前为 Memoh-inspired 有边界的功能里程碑。Bot 负责接收、排队和显示状态，独立 Worker 在隔离环境中运行 Pi。

**本次已实现并测试：协议/记忆/OAuth修复、持久排期、Telegram私聊适配器、独立稳定Root环境、受控包安装/HTTPS读取和管理界面。真实Docker、在线模型/Telegram、包安装与服务连续性仍未验收，不能视为完整Memoh或可生产部署版本。** 默认保持受限的ephemeral profile。新service profile见[设计与边界](docs/service-profile.md)，必须完成[实机验收](docs/service-acceptance.md)。

这次交付未部署、未登录或连接真实模型/Telegram。Pi 的完整官方源码已纳入 `vendor/pi/`，固定到 `4270522473e677ddba7b093caa0064a3df51d459`，不是换个名字调用 registry SDK。Dashboard 是无需构建的原生 JavaScript 客户端。本次在 macOS 完成无模型任务聊天、刷新和重启闭环及 Safari 检查；其模拟结果不能证明真实模型或 Linux 容器。当前实现仍以Linux为目标，最新验证与历史记录见 [docs/verification.md](docs/verification.md)。

## 先运行演示

需要 Node.js 24+。演示使用明确标注的确定性 FakeAdapter，没有 AI、Shell、模型计费或容器执行。

```sh
npm ci --ignore-scripts
npm run demo       # 无需浏览器/端口，真实 SQLite + 独立 Worker 进程
npm run demo:ui    # 专用 .chestnut-demo 目录；不加载 .env，API 与 Worker 两个进程
# 打开 http://127.0.0.1:4310
```

Dashboard 支持创建/选择 Bot、任务提交、历史与结果、进度事件、Steer、Follow-up、Cancel。默认端口 4310，仅允许 loopback。V1 没有登录/多人权限，不支持直接暴露到公网。

首次打开页面创建 Bot，再从任务聊天输入工作。演示默认每轮 10 秒，便于查看事件和操作；可用 `npm run demo:ui -- --data-dir /新的独立目录 --port 4310 --delay-ms 30000` 延长演示。Ctrl+C 停止，重启相同命令保留 Bot、任务和结果；入口拒绝真实模式或无法识别的已有数据目录。Demo 不显示模型登录，也不执行模型、工具、Shell、Docker 或渠道请求。

浏览器同一标签页刷新后恢复聊天草稿、任务选择和未确认请求编号；已接收但回复丢失的请求只查询回执，不自动重发。未接收的请求需手动重试相同内容；修改内容意味着新请求，先检查历史。取消/失败/中断后可点击 **Use prompt for a new task** 复制草稿，审核后明确点击 Start。已结束任务的 Steer 草稿不会自动转为 Follow-up。会话存储受浏览器设置限制，关闭标签页可能丢失未发送草稿；服务端历史仍在 SQLite。完整闭环、复现和边界见 [MVP 验收](docs/mvp-acceptance.md)。

### 长期记忆

选择 Bot 后打开 **Memory** 页签，可以保存偏好、纠正、决策和经验，搜索、修改或忘记笔记，并查看 Git 修改历史。`All my bots` 在当前用户的 Bot 间共享；`Only this bot` 仅对当前 Bot 可见；`This project` 需要先绑定项目 slug，共用该 slug 的 Bot 可读取项目记忆。全局开关停止所有 Bot 的记忆读写，已有数据保留。

记忆保存在数据目录的 `control/memory/` 独立本地 Git 仓库，不配置远端。每个 Task 自动读取固定版本的相关记忆，并在 Activity 与 **Memory used in this task** 显示实际加载/访问记录。Demo 仍使用 FakeAdapter，其结果只证明上下文传递，不代表真实模型理解或学习。

真实 Pi 通过平台提供的 `memory_search`、`memory_read`、`memory_save`、`memory_update`、`memory_forget` 工具访问本轮私有 broker；Git 和控制数据库不挂入容器。更新镜像时需要重新运行 `npm run pi:build`，已有实验持久容器的镜像/文件不能隐式替换。容器内 socket、真实模型使用这些工具和 VPS 行为仍需要 Linux 验收。

忘记会移除当前正文与索引，并阻止 Agent 用标准化后相同的内容重新保存；显式用户保存可以恢复。旧正文仍在 Git 历史中，自动维护另用来源时间屏障，跳过忘记前的旧任务；新任务中任意同义表达不在哈希抑制范围内。未提交的文件修改保持原状，平台暂停新的记忆写入并提示检查，不会自动覆盖。自动提炼和每日 Dreaming 已接到独立 Worker，自动条目仅属于来源 Bot，矛盾建议保留待核实。本版接口、来源和维护契约见 [记忆开发设计](docs/memory-design.md)。

`npm run api` 和 `npm run worker` 可以分别启动；`npm run doctor` 检查 SQLite、Rootless Docker 和模型配置。`npm run build` 是 TypeScript 校验，Node 24 直接执行可擦除类型的 TS，不需要应用转译产物。

部署准备先看 [启动与失败恢复指引](docs/deployment-runbook.md)：`npm run preflight -- --offline` 是不初始化状态的只读检查；`npm run acceptance:offline` 复用完整离线测试；`npm run acceptance:docker` 默认只列计划，必须明确加 `--execute --data-dir <新的独立目录>` 才运行 Linux/Docker 验收子集。它们不会安装系统软件、开放公网或自动使用模型/Telegram。`doctor` 会初始化数据目录，不应当作只读预检。

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
4. 通过外层 Worker 环境/密钥管理器配置 `OPENAI_API_KEY`。也可以在Dashboard通过ChatGPT授权选择模型，使用固定官方Responses路由。凭据只留在外层，运行中的任务绑定授权代次与模型，换号/换模型后旧任务会停止。
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

### 新 service profile、排期和渠道

新service profile把常驻Root环境与每次Pi任务分开：正常成功任务可保留服务，取消/失败/不确定状态会停整个环境，rootfs保留。使用新的数据目录并明确设置CHESTNUT_SANDBOX_PROFILE=service与CHESTNUT_EXPERIMENTAL_SERVICE=1。不要在旧profile目录隐式切换。[具体配置与网络边界](docs/service-profile.md)

Environment页管理包/HTTPS域名白名单与停止环境；默认都不允许。包安装通过固定可信下载器验证Debian签名和SHA256，导入后只在network-none的Bot里安装。下载器明确使用bridge但不挂载Bot数据/凭据；这不是通用网络出口。

Environment 页新增可选的 **Bot Chromium 桌面** 与 **停止状态文件快照/显式恢复**。Agent 通过本任务私有 broker 截图、点击、输入、按键和切换浏览器窗口，管理页轮询同一 Bot 的屏幕。首版只允许容器内离线页面；快照包含 rootfs 和 workspace 文件，排除受管浏览器登录、进程内存与宿主控制数据。恢复先创建保护快照，失败保留旧环境并阻断新任务，需显式恢复保护版本。它们仍未经真实 Linux/Docker 验收，配置、限额和恢复步骤见 [桌面与快照](docs/desktop-snapshots.md)。

Schedules页支持一次性任务和带IANA时区的5段cron，持久化触发、暂停/恢复、历史、重启去重与重叠跳过。[排期语义](docs/schedules.md)

Telegram适配器只接受指定owner的指定私聊，独立长轮询进程处理状态、steer、cancel和follow-up。token只进渠道进程；通知有持久账本，发送结果不明时不盲重发。[配置与待验收项](docs/telegram-channel.md)

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

- 默认 profile 是每 Bot 持久 workspace + 每 Task 独立 Pi session，根文件系统只读且每 Run 重建。实验 persistent profile 保存每 Bot 的可写容器根文件系统，按 Task 执行，但每次任务结束会停止整个 Bot，保留文件而不保留运行中服务。新service profile另见上文。所有profile都没有每Task Git worktree，shell中没有任意apt/git/pip在线能力。受控包安装是单独的显式工具。
- 没有通用网络出口、完整外部集成市场、自动授权执行审批、DAG、Redis、Temporal或多人权限。Telegramtoken由独立外层渠道进程保管。Approvals 表是保留结构，不能当成完整审批功能。
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
