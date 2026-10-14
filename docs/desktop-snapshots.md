# Bot 桌面与文件快照（实验性）

本版把 Chromium 桌面放在每个 Bot 的稳定 service 容器内。管理页显示与 Agent 相同的 Bot 屏幕，Agent 使用本轮私有 `environment_computer` 工具操作。它不是宿主桌面，也不开放公网 VNC、CDP 或带凭据的控制 URL。**Mac Linux VM内真实文件、服务、快照恢复/保护rollback已验证；Chromium sandbox启动失败，截图/输入仍未通过。分项证据见 [最新验证](verification.md) 与 [浏览器阻塞](chromium-sandbox-blocker.md)。**

## 选择与启动

需要现有的 Linux Rootless Docker、util-linux flock、委派 cgroup v2 资源控制、Node 24+ 和新的私有短数据目录。遵循 [service profile](service-profile.md) 的配置；本文件不授权安装宿主软件、改变 Docker 安全配置或部署。

在已验证的 rootless daemon 上，先运行原有 `npm run pi:build`（它拒绝 rootful daemon），再构建独立桌面镜像：

```sh
docker build --file src/sandbox/Dockerfile --build-arg WITH_DESKTOP=1 \
  --tag chestnut-pi-desktop:4270522473e6 .
```

桌面依赖仅安装到镜像；该构建仍会从官方 npm/Debian 源取得依赖，不是离线安装。配置必须同时包含：

```dotenv
CHESTNUT_MODE=pi
CHESTNUT_SANDBOX_PROFILE=service
CHESTNUT_EXPERIMENTAL_SERVICE=1
CHESTNUT_NETWORK_POLICY=none
CHESTNUT_DESKTOP_ENABLED=1
CHESTNUT_IMAGE=chestnut-pi-desktop:4270522473e6
CHESTNUT_DATA_DIR=/home/you/chestnut-desktop-test
```

不隐式升级已有 Bot 容器，不在旧 profile 数据目录切换。普通镜像没有桌面标签时拒绝启动桌面。文件快照不要求桌面开启，但只支持 Pi service profile。API 与独立 Worker 都必须使用同一配置。

Environment → Start / capture 只排队启动/采集操作，可在不连接模型时运行；等待 Worker 回执和屏幕时间戳。真实 Agent 输入仍需要已授权的 Pi 任务。正常成功任务可以保留桌面和服务；取消、失败、不确定状态停整个 Bot。PNG 是带时间戳的轮询画面，不是视频，也不是页面 DOM。

## 桌面边界

Xvfb `:99`、Openbox、Chromium 和 fixture 以容器 UID 1000 运行，固定 1280×800。Chromium 保留默认 sandbox；没有 `--no-sandbox`、特权或调试端口回退。不能在当前 rootless/seccomp 环境启动时直接拒绝。桌面 `/tmp` 是 256 MiB tmpfs，受管 HOME/profile、cookies、窗口状态和 session marker 放在其中，整个容器停止后丢失。

容器继续 `network=none`。受管 Chromium 的固定代理、URL 策略和本地拒绝 CONNECT/upgrade 的 fixture 仅允许 `http://127.0.0.1:8787/`、`about:blank` 与诊断页 `chrome://sandbox/`。这不开放 Bot 的其他 loopback 服务，也不复用受控 HTTPS-fetch 能力。真实策略、子资源和 sandbox 生效仍需下方 Linux 负测；静态政策测试不能证明它们生效。

`environment_computer` 支持 `screenshot/click/type/key/navigate/windows/focus`；坐标限定画面内，输入最多 2000 字符，按键白名单含 Page Up/Down 用于滚动，窗口 ID 必须来自本 Bot 浏览器。回执复用同一 call ID，关闭任务 grant 后拒绝新操作；执行结果不明时不自动重复点击。每个 Bot 的采集/输入串行化。工具把 PNG 作为图像返回给 Pi，并声明像素/页面文字是不可信内容；页面上的指令不是平台授权。

API 的 `GET /api/bots/:id/desktop` 返回状态；`GET .../desktop/frame?session=<current-session-id>` 返回 no-store PNG，旧 session 被拒绝。`POST .../desktop` 仅接受 `{requestId:<UUID>}` 来排队启动/采集，不提供操作者任意点击接口。现有 same-host/origin 与 loopback 单用户边界保留，不能直接暴露到公网。

## 文件快照与恢复

快照在确认无本 Bot 活跃任务后，取得既有 OS 锁并停止整个 service 容器，再保存 Docker rootfs image 和单独的 workspace 文件。Docker commit 不含挂载卷，所以 workspace 单独复制。[Docker commit 文档](https://docs.docker.com/reference/cli/docker/container/commit/)

包含 Bot 的已安装包/配置与常规 workspace 文件/目录。排除宿主数据库、授权库、模型凭据、broker/task grants、其他 Bot、受管 tmpfs 浏览器 profile 和进程内存/PID。它不是 CRIU checkpoint，不会恢复运行中进程、登录态或自动启动先前后台服务。受管 profile 的 tmpfs 行为见 [Docker tmpfs 文档](https://docs.docker.com/engine/storage/tmpfs/)。用户自行把秘密复制到 rootfs/workspace 时，它也会成为快照文件；本功能没有任意秘密识别/脱敏能力。

操作入口：

- `GET /api/bots/:id/snapshots`：本 Bot 摘要、manifest hash、操作阶段与结果标识；不返回完整文件清单或屏幕数据。
- `POST .../snapshots`：`{requestId,action:"snapshot"}` 创建。
- 同一入口：`{requestId,action:"restore",snapshotId,confirmed:true}` 明确恢复本 Bot 文件版本。
- `POST .../environment-operations/:operationId/rollback` 或 `/contain`：`{requestId,confirmed:true}` 明确处理唯一待确认操作。

每次恢复先发布当前环境的保护快照，验证目标 SHA-256、格式/Bot/profile、固定 Pi 来源与资源限制，再复制到独立 workspace stage、创建停止状态候选容器并验证完整配置。交换文件和容器时把旧容器/旧 workspace 留在独立名称下，最后才改变登记 identity。不会自动删除旧版本。成功恢复仍停着，之后可显式启动桌面或提交任务；进程不会从内存恢复。

操作 `queued/running/uncertain` 都阻止本 Bot 新任务，调度器跳过此 Bot。全局重任务/环境操作串行。Worker 重启后对已 running 的失主操作标记 uncertain，不重放；活跃 owner 仍保留操作。API 202 是排队回执，不能当成功。重复 requestId+相同 payload 返回原回执，不同 payload 拒绝。

失败保留阶段、partial/protection/candidate 标识，界面显示待确认并阻断新任务。有保护快照时只能明确 rollback，不能只清标记；rollback 恢复保护文件和保留的旧容器，核验后解除阻断。保护快照尚未发布的失败可显式 contain，必须验证停止。恢复本身再次失败仍阻断，可对新的唯一 uncertain 操作明确恢复。不要手动删除候选/旧容器、修改登记 identity 或跳过锁。无法验证的身份/校验和仍需离线人工核对，不会冒充已恢复。

## 容量与文件格式

每 Bot 最多 16 个已发布快照（保护版本也计数），workspace 最多 20,000 项、512 MiB，Docker save archive 最多 8 GiB，SizeRootFs 最多 4 GiB；空间准入保留 rootfs×3 + workspace×3 + 512 MiB。保护快照占一个槽位，因此满额时恢复也会拒绝。没有自动永久清理接口；达到上限需另行审核容量和留存方案。

workspace 复制先使用可写 staging 目录，填充完毕后从子目录向父目录显式恢复权限，重新核对完整 inventory 后才允许发布或交换；不依赖宿主 umask。旧版本已保存但校验不一致的快照仍拒绝加载，不会自动修改其 manifest。

workspace 拒绝 symlink、hardlink、设备、socket 和其他特殊文件。Docker 生成的外层 tar 仅允许目录/常规文件和受支持索引，拒绝绝对路径、穿越、重复记录、links、devices 和扩展头；不接受用户上传或宿主 tar 解压。版本/归属/文件/manifest/archive 校验失败均拒绝。目录、归属、路径与锁 fence 同样核验。这些限额不是 Docker writable-layer 磁盘配额；其他运行日志和镜像仍能耗尽宿主磁盘。

## Linux 实机验收门槛（分项结果见最新验证）

在明确授权的新测试环境，用新 Bot/数据目录且不使用真实账号或凭据：

1. 构建镜像并确认 rootless/cgroup 控制、无 privilege、network none、精确 workspace/tmpfs 挂载；若 Debian Chromium 在默认 seccomp/user namespace 下不能启动，记录阻塞，禁止关闭 browser sandbox 回退。
2. 模型无关 Start / capture 显示有效 PNG 和本 Bot session。之后用已授权模型任务的工具导航 fixture、截图、点击 Name、输入样例、点击 Greet、按键滚动、枚举/切换窗口；管理页看到同一实际画面，切 Bot 不显示旧画面。
3. `chrome://sandbox/` 与实际进程证明 Chromium sandbox 开启。URL/子资源/CONNECT/WebSocket、其他 Bot 和其他 loopback 服务都做负测。检查没有公网控制端口或外层授权数据进入 Bot。代理文档：[Chromium proxy](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md)。
4. rootfs 和 workspace 写入独立样例，快照 A，改变文件，再恢复 A。保护版本可见；确认两处文件正确、服务保持停止、登录和进程内存不恢复；重启服务仅作为新启动验收。
5. 在各持久阶段实际杀 Worker/锁 holder，并重启。旧任务与不明操作不得自动重放；检查 retained artifacts 和明确 rollback/contain，再接收新任务。单元测试的阶段异常注入不是真实 SIGKILL/daemon 验收。
6. 校验和破坏、跨 Bot ID、links/特殊文件、未知 archive 格式、磁盘不足和槽位耗尽均 fail closed。Docker 真实 save 格式尚需验收；不支持的扩展头将安全拒绝，不能直接放宽路径检查。

现有 `acceptance:docker` 针对旧 service 核心，不自动覆盖以上新门槛。macOS 的本地 UI/VM 测试及假的 Docker 响应不等于本节通过。
