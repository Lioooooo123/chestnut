# Mac 本地 Linux VM 运行路径

当前目标是在 Mac 的 Linux VM 中运行 Chestnut API、Worker 和 Bot 容器。Mac 只运行已有 VM 管理器、开发工具和浏览器；Bot root 是 Linux 容器 root，不是 macOS root。**此提交提供只读预检和运行域约定，并不宣称真实 Bot/桌面/快照在当前 VM 已验收。**

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

后续具体前提是在该 Linux guest 中提供 Node 24+、rootless Docker 及其依赖，确认既有 uid/gid mapping 与 systemd cgroup delegation，并使用普通 guest 用户的私有 socket/存储。不要修改默认 rootful daemon，不关闭 AppArmor/seccomp/user namespace 检查或 browser sandbox。新增 guest 服务、软件和任何权限/安全设置动作应按当前授权范围逐项核实；本提交没有执行安装或 rootless setup，也不要求另装 Docker Desktop/OrbStack。

当前资源断言还要求 daemon 报告 CPU quota 等控制。现有 Docker 的模板未提供 `CpuCfsQuota` 字段；未来 rootless 配置仍需检查真实 API/resource enforcement，不能为了兼容字段缺失直接删除 CPU 限制或放行。

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

API 继续只监听 guest `127.0.0.1`。Mac 浏览器访问须明确核验当前 VM 管理器的 loopback 转发；不要把 `CHESTNUT_HOST` 改成 `0.0.0.0` 或发布无认证控制端口。当前还没有搭建/验收此项目的转发和服务启动入口，因此此处不是“一键启动已完成”的说明。模型/ChatGPT 授权另行安全交接，不能从其他应用寻找凭据。

## 保留的验收与恢复要求

VM 环境准备好后，先在新的项目测试目录验证真实 Linux flock、socket mode、broker↔容器、guest-native bind、ARM64 镜像构建和资源执行。再按 [桌面与快照门槛](desktop-snapshots.md) 验证 Bot rootfs/workspace 文件持久性、Chromium sandbox/输入/截图、保护快照恢复、实际 Worker SIGKILL 和服务重启。只能清理自己创建且 ownership 匹配的测试资源；快照旧容器/文件的保留规则仍适用。

控制数据库、锁目录与 rootless Docker image/container storage都在 guest 持久磁盘，重启同一 guest保留 identity，不能新建 profile冒充恢复。rootfs镜像与独立workspace必须成对校验；不能只复制workspace后声称系统安装状态已恢复。整个容器停止后受管tmpfs浏览器登录/进程内存丢失的边界不变。

## 与 Memoh 的取舍

Memoh 的 [固定版本 Compose](https://github.com/felinics/Memoh/blob/d06cba8965549fea6feac30b66e439eeb5c81cc9/docker-compose.yml) 把管理服务放在 Linux 容器运行域并持久保存 containerd/data；该文件的 privileged/pid:host 管理容器不是 Chestnut 的配置。本方案借运行域思路，保留已有 rootless、锁和私有 broker约束，不增加 privileged nestedcontainerd。rootless前提参见 [Docker 官方说明](https://docs.docker.com/engine/security/rootless/)，已有 VM 管理器使用参见 [Colima 官方仓库](https://github.com/abiosoft/colima)。
