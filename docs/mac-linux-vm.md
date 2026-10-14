# Mac 本地 Linux VM 运行路径

当前目标是在 Mac 的 Linux VM 中运行 Chestnut API、Worker 和 Bot 容器。Mac 只运行已有 VM 管理器、开发工具和浏览器；Bot root 是 Linux 容器 root，不是 macOS root。**已完成下述真实容器文件/服务/快照验收并运行 loopback API/Worker；Chromium sandbox 仍受阻，真实模型未连接。**

## 先检查已有环境

```sh
npm run mac:preflight -- --profile default
# 可选：--image chestnut-pi-desktop:4270522473e6
```

此入口只读取已有 Colima profile，停止/缺失时不启动或创建 VM。已经运行时通过 Colima 的现有 guest 连接检查 Linux、普通用户、Node 24、util-linux flock、本地 Unix Docker endpoint、rootless/cgroup 控制和固定 ARM64/amd64 image。Docker 探针清除 `DOCKER_HOST`/`DOCKER_CONTEXT`，避免 Mac 环境变量指向不同运行域；不切换持久 context。报告仅包含筛选结果，不回显原始 stderr、daemon 字段或模型凭据。

`passed` 只表示已检查的前提；`operationallyVerified` 始终 false。`readyForGuestAcceptance` 仍不是 VM 存储、socket 或真实容器验收。缺少 Node 不会阻止独立检查 flock/Docker。不要通过默认 rootful daemon 或宿主 Shell 回退绕过拒绝。

VM 启动是另一个显式动作。本次用户已批准按原配置执行 `colima --profile default start`。预检命令自身不会启动、安装、调资源/网络/权限，也不会创建状态目录、发布服务端口或读取授权库。不要对其他 profile 或已有服务执行停止、重装、清理、磁盘重置。

## 2026-10-14 实机核查与实际阻塞

本机 Darwin arm64 / Node 26.5.0，已有 Homebrew Colima 0.10.3 / Docker CLI 29.7.2。原 default profile 已停止，使用现有 VZ 实例启动成功，保持 2 CPU、约 2 GiB RAM、现有磁盘配置。Colima 自身恢复既有 VM 转发并创建了其 Docker context；未手动改变网络/权限，也未部署 Chestnut listener。

Guest 为 Ubuntu 24.04.4 LTS / Linux aarch64，普通用户 UID 501。真实 util-linux flock 2.39.3 可用，guest home `/home/lioooooo123.guest` 与 `/tmp` 均为 ext4，已有 subuid 范围。**Node/npm、dockerd-rootless.sh、rootlesskit、newuidmap/newgidmap、slirp4netns 与用户 Docker socket均缺失。**现有 daemon 是 rootful，cgroup v2 + cgroupfs，不能直接供当前 Chestnut 运行。未运行 Bot 容器、Chromium、模型调用或文件快照实机测试；2 GiB 下的构建/桌面容量尚未测量，未擅自扩容。

以上缺口是启动前历史状态。经用户明确批准，已在同一 guest 提供官方 Node 24.21.0 ARM64（SHA-256 `6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2`），安装 uidmap、Docker 29.5.2 rootless extras、slirp4netns、dbus-user-session 及其依赖。补充 xz-utils 时仅更新了所需 liblzma5；没有更换原 Docker。Git 原本存在，检查误改的自动安装标记已还原。Node 置于 VM `/opt/chestnut-tools/node-v24.21.0-linux-arm64`，新建 VM `/usr/local/bin/node/npm/npx` 链接，未改 Mac 软件。

官方 `dockerd-rootless-setuptool.sh --force install` 创建/启用 UID 501 的 systemd 用户 Docker 服务；`--force` 仅允许保留同时运行的 rootful daemon。原 daemon/数据保留。已有 linger、subuid/subgid 范围与 CPU/memory/pids delegation 可用，不需扩大范围或添加全局 cgroup/sysctl 设置。用户 daemon 是 rootless + systemd cgroup v2，私有 socket `/run/user/501/docker.sock`。JSON 的 `CpuCfsQuota=true` 实测通过；此前模板报错是 CLI模板字段名称差异，并非删除资源断言的理由。

原 2 CPU/约 2 GiB 配置下，原生 ARM64 源码镜像成功构建，未扩容。新镜像 tag 与旧容器 image identity 分开保存。当前 API/Worker 是真实 `pi/service`，不是 FakeAdapter；未连接模型/Telegram，未发 prompt，不能把它当成已工作的 AI 聊天。Chromium 出错与需批准的下一步见 [sandbox 阻塞](chromium-sandbox-blocker.md)。

## 把运行域留在 Linux guest

选择已准备好的 guest 中新的私有 **ext4 路径**，不要用 `/Users/...` 共享路径保存 SQLite、锁、broker、sessions、workspace 或快照。需要输送源码时复制到 guest-native 项目目录，再在 guest 中安装锁定依赖；不要绑定 macOS 的 Node 二进制、node_modules 或 AF_UNIX socket到容器。Linux daemon 的 bind source 必须确实存在于同一 guest，不能根据 Mac realpath 推断它已共享。

在 guest 的项目目录中，按现有 [Pi 源码构建](pi-source.md) 与 [service profile](service-profile.md) 配置，依次运行：

```sh
npm ci --ignore-scripts
npm --prefix vendor/pi ci --ignore-scripts
node scripts/pi-verify-source.mjs
node scripts/pi-hydrate.mjs
node scripts/pi-check-resolutions.mjs
npm --prefix vendor/pi run build:offline
npm run check
npm run pi:contracts
npm run pi:build
```

选择新 guest-native 数据目录并完成 `npm run preflight -- --docker --data-dir <new-private-guest-path>`。`npm run dev` 必须在 guest 项目目录、普通 guest 用户和已核验的 rootless context 下运行，让 API/Worker、OS lock holder、gateway 与 Docker 同处 Linux。初始关闭 Telegram/自动模型维护，不配置真实凭据；纯桌面采集/快照由 Worker 操作队列执行，无需连接模型。桌面镜像另按 [desktop-snapshots.md](desktop-snapshots.md) 构建；使用 ARM64 原生镜像，不强制 amd64 或把 Rosetta 作为已验收依赖。

API 继续只监听 guest `127.0.0.1`。Mac 浏览器访问须明确核验当前 VM 管理器的 loopback 转发；不要把 `CHESTNUT_HOST` 改成 `0.0.0.0` 或发布无认证控制端口。当前已使用原 Colima loopback 规则访问 Mac `http://127.0.0.1:4316`，并用 lsof确认仅127.0.0.1监听；未修改转发规则。模型/ChatGPT 授权另行安全交接，不能从其他应用寻找凭据。

## 保留的验收与恢复要求

VM 环境准备好后，先在新的项目测试目录验证真实 Linux flock、socket mode、broker↔容器、guest-native bind、ARM64 镜像构建和资源执行。再按 [桌面与快照门槛](desktop-snapshots.md) 验证 Bot rootfs/workspace 文件持久性、Chromium sandbox/输入/截图、保护快照恢复、实际 Worker SIGKILL 和服务重启。只能清理自己创建且 ownership 匹配的测试资源；快照旧容器/文件的保留规则仍适用。

控制数据库、锁目录与 rootless Docker image/container storage都在 guest 持久磁盘，重启同一 guest保留 identity，不能新建 profile冒充恢复。rootfs镜像与独立workspace必须成对校验；不能只复制workspace后声称系统安装状态已恢复。整个容器停止后受管tmpfs浏览器登录/进程内存丢失的边界不变。

## 与 Memoh 的取舍

Memoh 的 [固定版本 Compose](https://github.com/felinics/Memoh/blob/d06cba8965549fea6feac30b66e439eeb5c81cc9/docker-compose.yml) 把管理服务放在 Linux 容器运行域并持久保存 containerd/data；该文件的 privileged/pid:host 管理容器不是 Chestnut 的配置。本方案借运行域思路，保留已有 rootless、锁和私有 broker约束，不增加 privileged nestedcontainerd。rootless前提参见 [Docker 官方说明](https://docs.docker.com/engine/security/rootless/)，已有 VM 管理器使用参见 [Colima 官方仓库](https://github.com/abiosoft/colima)。

## 当前服务、重启与回退

本次专用测试服务为 guest 用户的 `chestnut-acceptance-api.service` 和 `chestnut-acceptance-worker.service`。配置只引用独立 guest-native 源码/测试数据路径，环境文件0600，无模型/渠道凭据；API/Worker保留no-new-privileges并分别有256/512 MiB控制面内存上限，Bot资源仍按固定容器配置限制。两者启用并在线。服务重启后相同Bot的三个快照ID与Worker在线状态保持，文件/镜像旧版本保留。

```sh
# Mac调用已有guest连接；不要用sudo运行Worker
colima --profile default ssh -- systemctl --user status chestnut-acceptance-api.service chestnut-acceptance-worker.service
colima --profile default ssh -- systemctl --user restart chestnut-acceptance-api.service chestnut-acceptance-worker.service
# 停止本次项目服务，保留数据/容器/快照
colima --profile default ssh -- systemctl --user disable --now chestnut-acceptance-api.service chestnut-acceptance-worker.service
# 如明确回退用户rootlessdaemon，先停止本次Worker，再只停止该用户服务
colima --profile default ssh -- systemctl --user disable --now docker.service
```

这些是运行控制命令，不自动执行。不要停止系统级rootfulDocker或删除磁盘/profile/data。Node链接、包、用户unit和所有测试文件均保留并记录，未自动卸载。失败浏览器测试的三个锁holder在确认唯一marker/exe、无Docker子进程、容器停止且无exec后已人工式核验清理；marker改名保留为.reconciled，lock文件与rootfs不删除。

真实通过：两Bot文件/loopback服务隔离、后台服务跨执行保留、whole-Bot stop/restart保留文件并停止服务、实际API/Worker快照创建、rootfs+workspace恢复、保护版本及真实部分恢复异常后的显式rollback；权限0775也在真实文件快照中校验。异常注入不是实际Worker SIGKILL；完整VM重启、恶意负载/磁盘压力、在线包安装、真实模型和Telegram仍未做。Chromium截图/点击/输入未通过，不能提供实际桌面PNG。
