# Chestnut 记忆开发设计

决策日期：2026-10-12。

Chestnut 使用独立的本地 Git 仓库保存长期记忆，采用 Devin Memory 与 Agent Memory Repo 的 Markdown 组织方式。现有 SQLite 继续管理任务、执行状态和事件。会话内容、任务进度与长期记忆分别管理；记忆只保存偏好、纠正、长期决策及原因、可复用经验。

## 参考与范围

- [Devin Memory and Dreaming](https://docs.devin.ai/product-guides/memory)：会话读取自己的记忆版本，按需读取笔记，更新保留来源，并展示修改。
- [Agent Memory Repo 格式](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/SPEC.md)：短 `MEMORY.md`、主题笔记、来源元数据及 `[[path]]` 链接。
- [Knowledge 迁移说明](https://docs.devin.ai/onboard-devin/knowledge-onboarding)：旧 Knowledge 已弃用，工作流程由 Skills 管理。

记忆层包含加载、检索、保存、修改、忘记、关闭、版本历史、Pi 平台工具，以及任务结束后的自动提炼和定期 Dreaming。真实 Pi 模式由外层模型提炼；Demo 只处理用户明确的“Remember:”或“记住：”文本，不把模拟结果称为模型学习。

## 存储与归属

数据目录的 `control/memory/` 是平台管理的独立 Git 仓库，不提交到 Chestnut 代码仓库，不放在 Bot 可写 workspace 或容器内。默认 `.chestnut/` 数据目录由代码仓库忽略；部署时通过 `CHESTNUT_DATA_DIR` 指定独立数据位置。首版为单用户本地产品，唯一用户是当前数据目录的拥有者，不从请求或模型参数接受任意 owner。

`MEMORY.md` 保存少量通用偏好及索引；`notes/<UUID>.md` 保存单条 Markdown 笔记；`.chestnut/state.json` 保存范围、来源、版本、启用设置、Bot 项目关联、请求去重记录和忘记指纹。笔记正文只有 Markdown 一份权威副本；索引由同一次提交生成。运行时只能读取已提交的 Git tree。

范围包括 `personal`、`project`、`bot`。个人偏好在此用户的多个 Bot 间可用；项目记忆只对显式绑定到该项目的 Bot 可用；Bot 记忆仅属于指定 Bot。项目标识采用受限 slug，不接受文件路径。范围与来源由控制面检查，不能让模型指定另一 Bot 身份。既有 Bot API 不改变任务语义。

忘记会删除当前正文和索引链接，并保存标准化内容的哈希，阻止 Agent 用同一内容重新写入。显式用户重新保存可以覆盖这条抑制。历史 Git 提交仍保留旧正文，因此“忘记”是从活跃记忆和未来召回移除，不是彻底抹除所有历史。自动提炼同时使用来源时间屏障：忘记后不再使用删除之前启动的旧任务作为提炼来源，也清理旧矛盾建议。这会保守地跳过同期其他旧任务，避免同一事实被改写后重新生成。关闭和重新开启记忆也会推进屏障，关闭期间的任务不会在重开后补录。新任务中的任意同义表达仍不能仅靠哈希识别；不宣称实现全部语义遗忘。

## 版本与并发

API 与 Worker 使用独立 SQLite 锁文件的事务串行化 Git 修改。每条笔记有独立 revision；修改与删除必须提交读取时的 revision。不同笔记的修改可以合并，同一笔记的过期修改返回 409，用户或模型读取最新版本后重新决定。每次修改带 UUID requestId，相同请求重复调用不产生重复提交，不同 payload 复用 ID 返回 409。

Git commit 是保存完成的边界。文件写入后进程崩溃而尚未提交时，只读已提交版本，后续写入返回需要检查的错误；不自动提交未知改动、不覆盖或清空脏文件。已提交的操作通过仓库内请求记录在重启后去重。Git hook 和签名不参与平台写入；不配置远端、不创建托管仓库。

## 执行与 Pi 工具

每个 Task 在执行前读取固定 Git commit 的记忆快照；同一 Task 的查询始终读取该版本。自动上下文包含有限个人偏好和本次 prompt 相关条目，记录 `memory.loaded` 的 commit 与条目 ID。其他条目通过 `memory_search`、`memory_read` 按需取得，并记录访问事件。关闭记忆后，不再注入或响应记忆工具读取、写入。

真实 Pi 通过显式加载的平台 extension 使用 `memory_search`、`memory_read`、`memory_save`、`memory_update`、`memory_forget`。extension 通过本轮私有 Unix socket 与外层 broker 通信，不接触权威 Git 仓库、控制数据库或同步凭据。工作区自动 extension、MCP 和 context-file discovery 仍禁用。

broker 校验执行 lease、取消状态和持久环境 OS 锁；每次请求的 Bot 和来源 Task 固定为当前 Run。新记忆供后续 Task 使用，当前 Task 不悄悄切换快照。对已经读取的旧 revision 做修改必须仍经过乐观并发检查。能力说明随平台工具提供。

## 接口

`GET /api/bots/:botId/memory` 返回当前可见笔记、仓库 commit、全局启用设置、Bot 项目关联及最近修改历史，可选 `q` 做文本检索。`POST` 创建笔记，`PATCH /:id` 修改，`DELETE /:id` 忘记。写入携带 requestId；修改和忘记携带 expectedRevision。可选 sourceTaskId 必须属于此 Bot，手动保存的来源标记为用户输入。

`PATCH /api/bots/:botId/memory/settings` 修改全局启用设置和此 Bot 的项目绑定，携带 expectedVersion 与 requestId。全局开关在界面中明确说明影响所有 Bot。

## 界面

在现有 Bot workspace 增加 Memory 面板，沿用现有浅色、绿色控件和原生 CSS。提供范围、项目关联、搜索、正文、来源、修改、忘记、启用开关和 Git 修改历史。任务详情展示本轮加载或访问的条目。所有记忆文字通过文本节点显示，用户错误保留输入；旧响应不能覆盖新 Bot 的界面。

## 验收约定

先通过 Memory 公共接口验证真实 Git、重启持久化、请求去重、过期写入、范围隔离、忘记抑制、关闭以及脏仓库行为；再通过 API 验证来源绑定和错误状态，通过 Worker 验证固定快照及事件，通过 Pi extension/broker 验证实际注册和 lease 撤销。每个行为测试先失败再实现。

最后启动当前代码的 API 与独立 Worker，在内置浏览器验证创建、搜索、修改、忘记、关闭、项目/Bot 切换及窄屏。真实 Linux 容器、模型推理、跨容器 socket 和 VPS 接受度单独记录，不以 Mock 或 Demo 代替。

## 自动提炼与 Dreaming

独立 Worker 在终态任务之后触发后台维护，不占用前台任务队列。按 terminal event seq 增量读取成功或失败的 Task，包含原始用户 prompt、已发送 steer 和最终 result；取消或结果未知的任务不作为来源。正常任务进度、一般会话总结和易重新获取的事实不应写入长期笔记。

默认启用自动维护。首次完成任务会运行 Dreaming，此后有使用的 Bot 每 24 小时整理一次；没有新活动的空 Bot 不运行。`CHESTNUT_MEMORY_AUTOMATIC=0` 关闭自动调度，界面显式触发仍可运行；记忆全局关闭则所有读写和维护都停止。每次最多处理 10 个新任务，Dreaming 额外参考最多 10 个近期任务和 30 条近期可见笔记；任务文字限 16000 字符，单条笔记上下文限 200 字符。维护是有界增量整理，不宣称一次完整扫描所有历史。

Pi 使用外层 `OPENAI_API_KEY`、既有 `CHESTNUT_MODEL` 和固定官方 Chat Completions endpoint，JSON 输出，不提供执行工具。一次模型请求最多 30 秒、2500 输出 token；每天最多 `CHESTNUT_MEMORY_DAILY_CALLS` 次（默认 24，可设 1–200）及 160000 字符输入。失败调用计入预算，不立即重试，至少退避 60 秒。预算按整个数据目录累计，独立于 Task 模型调用。Worker/API 进程重启不清零预算。

自动新增条目仅写入来源 Bot 的范围，标记 `origin=automatic`，不自动推广成个人或项目记忆。每条新增或矛盾建议必须带真实来源 Task ID 和原文 quote，控制面检查归属与原文包含关系；这证明来源对应关系，不证明模型语义推理正确。偏好、纠正、决策只接受用户原文，经验也可来自最终结果。常见凭据模式的整段文字被过滤，候选笔记再次检查；不宣称能覆盖所有凭据格式。

Dreaming 提炼漏掉的经验，跳过相同内容，并可删除有保留等价条目的自动 lesson。用户创建或修改的笔记以及偏好、纠正、决策禁止自动删除；语义矛盾、过时或临时条目的建议保留为待核实记录，用户在编辑器明确保存或驳回。自动语义合并和无来源的清理不直接提交。

`.chestnut/state.json` 保存各 Bot 的已处理游标、最近 Dreaming 时间和待核实建议，与笔记及请求去重记录在同一次 Git 提交落盘。跨进程全局租约、调用预算和维护状态保存在现有控制 SQLite 的 `memory_jobs`/`memory_budget`。请求推理期间不持有 Git 写锁，提交时重新校验版本、启用状态及维护租约；过期结果不会覆盖用户修改，Git 已提交但状态回执尚未更新的中断通过请求 ID 去重。

`GET /api/bots/:botId/memory/maintenance` 返回维护状态及 Git 游标/建议；`POST` 携带 requestId 排队一次 Dreaming；`DELETE` 携带 requestId 和建议 id 驳回建议。API 不调用模型，真实推理只在 Worker 中发生。界面展示维护状态、最近整理时间、错误、来源和待核实建议，并提供 Dream now。
