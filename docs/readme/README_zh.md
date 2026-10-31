<div align="center" dir="ltr">

[English](../../README.md) · **简体中文** · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console 是基于 Docker 的 Dune: Awakening 专用服务器管理工具，支持 Linux、Windows/WSL2 和虚拟机。它提供引导式安装和浏览器管理面板，让你无需长期使用终端，即可管理玩家、地图、备份、更新和服务器运行。

这是一个非官方社区项目，与 Funcom 无关联，也未获其认可、赞助或支持。

本项目处于实验阶段，Funcom 的自托管服务器行为可能随时间变化。

## 你可以做什么

- **部署与运维：** 浏览器引导设置、更新、服务控制、定时重启、重启队列、诊断和恢复。
- **实时掌握动态：** 交互式世界地图、玩家与载具追踪、资源位置、服务器健康状态、性能和日志。
- **配置厄拉科斯：** 管理地图、Sietch、Deep Desert 布局、自动伸缩、内存、游戏设置，以及**实验性的 Regis Tanks**。
- **管理玩家：** 玩家与公会工具、物品栏、进度、基地、仓储、载具、Landsraad、奖励和 Care Packages。
- **管理经济：** 浏览 Exchange 挂单，并使用内置 Market Bot 自动交易。
- **保护服务器：** 数据库备份、加密系统备份、恢复与迁移工具、访问角色、限定权限的 API 密钥和加密 API 访问。
- **建造与分享：** 设计 3D 基地、导入和分享蓝图，通过公开服务器资料页和延迟检测展示你的服务器。
- **按需定制：** 社区插件、Discord 集成、多语言 Console，以及社区提供的翻译修正。

请查看[截图集](../screenshots.md)，进一步了解界面。

## 环境要求

你无需精通 Linux。安装程序会检查基本条件，并在受支持的 Linux 系统上准备 Docker。

| 项目 | 建议 |
|---|---|
| 服务器 | 推荐全新安装的 64 位 Ubuntu 服务器，这是最简单的选择。也支持其他 Linux 发行版、Windows/WSL2 上的 Docker Desktop 和虚拟机。 |
| Docker | 在受支持的 Linux 系统上，如果 Docker 尚不可用，安装程序会进行准备。 |
| CPU | 支持 AVX/AVX2 |
| 内存 | 起步为 20 GB RAM；增加持续运行的地图时，建议 30–40 GB 或更多 |
| 存储 | 200 GB 或更多 |
| Funcom 令牌 | 在浏览器设置过程中安全输入 |

<details>
<summary>内存与 CPU 使用建议</summary>

RAM 决定了可以稳定运行多少个 Dune 地图服务器。如果不确定，请先从基本布局开始，再为更多持续运行的地图或更活跃的玩家增加内存。

官方 Survival 服务器即使没有在线玩家，也通常保持约 10–12 GB 常驻内存；单次空闲状态的快照本身不能证明存在内存泄漏。`docker stats` 的 CPU 使用率按核心计量：`100%` 表示一个逻辑 CPU 被完全占用。

| 服务器布局 | 建议 RAM |
|---|---:|
| 入门基本服务器 | 20 GB |
| 主世界加额外剧情／社交地图 | 30 GB |
| 主世界、额外地图及 Deep Desert | 40 GB |
| 大量持续运行的地图或较高玩家活跃度 | 60 GB+ |

</details>

如需面向互联网提供公开服务器，请转发以下端口：

| 端口 | 协议 | 用途 |
|---|---|---|
| `8088` | TCP | Web 管理面板；仅允许可信管理员访问 |
| `31982` | TCP | RabbitMQ 游戏消息端点 |
| `31983` | TCP | RabbitMQ 游戏 HTTP 端点 |
| `7777-7810` | UDP | 游戏流量 |
| `32000-32015` | UDP | 可选的公开目录直接延迟探测；关闭时仍可使用中继 |
| `8797` | TCP | 可选的加密 API 访问（HTTPS）；参见[加密 API 访问](../console/encrypted-api.md) |

请勿公开数据库端口和内部管理端口。不要向不可信用户开放 Web 界面。

## 安装

请使用具有 `sudo` 权限的普通用户运行安装程序，不要以 `root` 身份登录运行。安装程序仅在需要时请求管理员权限。

在全新 Linux 服务器上复制并执行以下命令：

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

安装程序会下载最新发行版、启动 Web 界面，并告诉你应打开的地址。在浏览器中完成剩余设置即可。

默认安装路径为 `~/dune-awakening-selfhost-docker`。如需使用其他 Linux 磁盘，请明确指定完整目标路径：

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

在 Windows 上，请在受支持的 Linux 虚拟机或 Ubuntu WSL2 终端中运行命令，不要使用 PowerShell、命令提示符或 Docker Desktop 内部终端。安装程序会在解压前检查目标是否可写以及空间是否充足；下载失败不会留下被部分覆盖的安装。

在 Alpine Linux 上，安装程序使用发行版提供的 Docker 和 Docker Compose 软件包，并通过 OpenRC 启动 Docker。如果 community 软件仓库不可用，安装程序会在修改仓库配置前征求同意。

## 公开服务器目录

[DuneDocker.app](https://dunedocker.app/) 帮助公开服务器的所有者展示社区，也帮助玩家找到合适的服务器。每条记录都有实时服务器页面，显示状态、玩家人数、区域、Sietch、针对访问者测量的延迟，以及可选的 Discord 社区链接。

所有者可以直接从 Console 的设置页面认领记录、验证所有权、管理公开资料和 Discord 邀请链接，并通过目录推广服务器。公开展示可随时启用或关闭。

个性化延迟检测使用 UDP `32000-32015`，以获得最快的直接测量结果。请在主机防火墙，以及互联网到 DMZ 的防火墙或 NAT 转发中放行该范围。没有开放此范围的服务器仍兼容，并会自动使用 Dune Docker 中继。

本地服务器和仅供局域网使用的服务器不会公开列出。为保持透明，默认情况下安装实例只参与匿名服务器数量统计，不包含服务器名称、地址、玩家或设置。此功能可在设置中单独关闭。

## 基地建造工具

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) 是浏览器中的 Dune: Awakening 基地 3D 规划与分享工具。你可以在游戏中投入时间和材料之前试验布局，使用可搜索的建筑与摆放物目录，以及放置、吸附、旋转、碰撞和领地覆盖工具。

从不同角度预览设计，切换昼夜，漫游完成的布局并截图。现有布局可以导入以便规划，完成的设计也可以导出以供后续使用。

登录后的社区成员可以保存项目，选择公开、不公开列出或私有可见性，发布预览，浏览社区设计，并复制已发布的蓝图作为起点。Console 页脚也提供了基地建造工具的直接链接。

## 社区插件

社区插件提供可选工具，可从 Web 界面安装和管理。插件会在安装前声明权限，更新会保留已有设置，并且任何新增权限都需要批准。

开发者可以从[官方插件模板](https://github.com/Red-Blink/dune-docker-addon-template)开始。

## 帮助与文档

- [官方网站](https://dunedocker.app/) — 项目信息、安装指引、常见问题和服务器目录
- [基地建造工具](https://blueprints.dunedocker.app/) — 在 3D 中规划、预览、保存和分享基地布局
- [官方文档](https://docs.dunedocker.app/) — 使用指南、功能说明、技术参考和 API 文档
- [Discord 社区](https://discord.gg/duneawakeningdocker) — 支持、更新、插件和社区讨论
- [仓库文档](../README.md) — 与源代码一起维护的技术说明与参考资料
- [支持项目](https://ko-fi.com/redblink) — 支持开发、测试和基础设施

## 参与贡献

Dune Docker 欢迎开发者、服务器所有者和玩家参与。在开始前，请查看已有的 [Issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) 和 [Pull Requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls)，避免重复工作。

- **报告问题：** 提供项目版本、复现步骤和预期结果。附上相关日志或截图前，请移除密码和个人信息。
- **提出改进：** 说明你的想法解决什么问题，以及如何帮助社区。较大的变更请先通过 Issue 讨论。
- **提交 Pull Request：** 保持修改范围集中，关联相关 Issue，并说明改了什么、如何测试。
- **参与代码以外的工作：** 改进文档、测试修改、制作社区插件，或直接从 Console 提交翻译修正建议。

如需提问或讨论想法，请加入 [Discord 社区](https://discord.gg/duneawakeningdocker)。

## 致谢与许可

Dune Docker Console 由 RedBlink 主导和维护，并得到社区贡献。分享或再分发本项目时，请注明 RedBlink 为原始开发者。

**本项目免费开源，采用 [MIT 许可证](../../LICENSE)。**
