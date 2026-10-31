<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · **繁體中文** · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console 是基於 Docker 的 Dune: Awakening 專用伺服器管理工具，支援 Linux、Windows/WSL2 與虛擬機器。透過引導式安裝及瀏覽器管理介面，即可管理玩家、地圖、備份、更新及伺服器運作。

這是非官方社群專案，與 Funcom 無關，亦未獲其認可、贊助或支援。本專案處於實驗階段，Funcom 的自行託管行為可能改變。

## 你可以做什麼

- **部署與維運：** 瀏覽器引導設定、更新、服務控制、排程重新啟動、重啟佇列、診斷與復原。
- **即時掌握動態：** 互動式世界地圖、玩家與載具追蹤、資源位置、伺服器狀態、效能與日誌。
- **設定厄拉科斯：** 地圖、Sietch、Deep Desert 配置、自動擴縮、記憶體、遊戲設定及**實驗性的 Regis Tanks**。
- **管理玩家：** 玩家與公會工具、物品欄、進度、基地、倉儲、載具、Landsraad、獎勵與 Care Packages。
- **管理經濟：** 瀏覽 Exchange 掛單，並透過內建 Market Bot 自動交易。
- **保護伺服器：** 資料庫與加密系統備份、還原與遷移、存取角色、限定權限的 API 金鑰及加密 API 存取。
- **建造與分享：** 3D 基地設計、匯入與分享藍圖、公開伺服器資料頁及延遲檢測。
- **按需自訂：** 社群附加元件、Discord 整合、多語言 Console 與社群翻譯修正。

查看[螢幕截圖集](../screenshots.md)。

## 環境需求

不需精通 Linux；安裝程式會檢查基本條件，並在支援的 Linux 系統準備 Docker。

| 項目 | 建議 |
|---|---|
| 伺服器 | 全新安裝的 64 位元 Ubuntu 最簡單；亦支援其他 Linux、Windows/WSL2 的 Docker Desktop 與虛擬機器。 |
| Docker | 在支援的 Linux 上，若尚未安裝，安裝程式會準備 Docker。 |
| CPU | AVX/AVX2 支援 |
| 記憶體 | 起步 20 GB RAM；額外常駐地圖建議 30–40 GB 以上 |
| 儲存 | 200 GB 以上 |
| Funcom 權杖 | 在瀏覽器設定時安全輸入 |

<details>
<summary>記憶體與 CPU 建議</summary>

RAM 決定可穩定執行的地圖數量。先從基本配置開始，再依常駐地圖與玩家活動增加記憶體。官方 Survival 伺服器即使無玩家，也常有 10–12 GB 常駐記憶體；單次閒置讀值不代表記憶體洩漏。`docker stats` 的 `100%` 代表一個邏輯 CPU 滿載。

| 配置 | 建議 RAM |
|---|---:|
| 基本入門伺服器 | 20 GB |
| 主世界與額外劇情／社交地圖 | 30 GB |
| 主世界、額外地圖及 Deep Desert | 40 GB |
| 大量常駐地圖或高玩家活動 | 60 GB+ |

</details>

公開網際網路伺服器請轉送以下連接埠：

| 連接埠 | 協定 | 用途 |
|---|---|---|
| `8088` | TCP | 網頁管理介面，僅限可信任的管理員 |
| `31982` | TCP | RabbitMQ 遊戲訊息端點 |
| `31983` | TCP | RabbitMQ 遊戲 HTTP 端點 |
| `7777-7810` | UDP | 遊戲流量 |
| `32000-32015` | UDP | 選用的公開目錄直接延遲探測；關閉時使用中繼 |
| `8797` | TCP | 選用的 HTTPS API；參閱[加密 API 存取](../console/encrypted-api.md) |

資料庫與內部管理連接埠應保持私有。勿向不可信任使用者開放網頁介面。

## 安裝

請以具有 `sudo` 權限的一般帳號執行，不要使用 `root` 登入；僅在需要時要求管理權限。在全新 Linux 伺服器執行：

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

安裝程式會下載最新發行版、啟動網頁介面並顯示網址。在瀏覽器完成設定即可。預設路徑為 `~/dune-awakening-selfhost-docker`；使用其他磁碟時，請指定完整路徑：

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Windows 使用者應在支援的 Linux 虛擬機器或 Ubuntu WSL2 終端執行，勿使用 PowerShell、命令提示字元或 Docker Desktop 內部終端。解壓縮前會檢查寫入權限與空間；下載失敗不會留下部分覆寫的安裝。

Alpine Linux 使用發行版的 Docker 與 Docker Compose 套件，透過 OpenRC 啟動；community 軟體庫不可用時，修改設定前會先詢問。

## 公開伺服器目錄

[DuneDocker.app](https://dunedocker.app/) 協助社群展示伺服器，讓玩家找到合適的選擇。公開頁面包含即時狀態、玩家數、區域、Sietch、個人化延遲及選用的 Discord 連結。

在 Console 設定認領伺服器，驗證所有權、管理公開資料與 Discord 邀請，並推廣伺服器。可隨時啟用或停用公開展示。

直接延遲檢測使用 UDP `32000-32015`；請在主機防火牆、網際網路至 DMZ 的防火牆及 NAT 轉送放行。未開放的伺服器會自動使用 Dune Docker 中繼，仍然相容。

本地及僅限 LAN 的伺服器不會列出。預設只提供匿名伺服器數量統計，不包含名稱、位址、玩家或設定；可在設定中另外關閉。

## 基地建造工具

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) 提供瀏覽器 3D 基地規劃與分享功能。先測試配置再投入遊戲時間與材料，並使用可搜尋的建築目錄、放置、吸附、旋轉、碰撞及領地覆蓋工具。

切換視角與晝夜、漫遊配置及拍攝截圖。可匯入既有配置並匯出設計。登入後可儲存專案，選擇公開、不公開列出或私有，發布預覽、探索社群設計及複製已發布藍圖。Console 頁尾亦有直接連結。

## 社群附加元件

在網頁介面安裝及管理選用工具。附加元件會於安裝前宣告權限；更新保留設定，新增權限須經同意。開發者可使用[官方附加元件範本](https://github.com/Red-Blink/dune-docker-addon-template)。

## 說明與文件

- [官方網站](https://dunedocker.app/) — 專案、安裝、常見問題與伺服器目錄
- [基地建造工具](https://blueprints.dunedocker.app/) — 3D 規劃、預覽、儲存與分享
- [官方文件](https://docs.dunedocker.app/) — 指南、功能、技術與 API 參考
- [Discord 社群](https://discord.gg/duneawakeningdocker) — 支援、更新、附加元件及討論
- [儲存庫文件](../README.md) — 與原始碼一同維護的技術資料
- [支持專案](https://ko-fi.com/redblink) — 協助開發、測試與基礎設施

## 參與貢獻

歡迎開發者、伺服器管理者與玩家參與。先查閱 [Issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) 與 [Pull Requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls)，避免重複工作。

- **回報問題：** 提供版本、重現步驟與預期結果；日誌及截圖請移除密碼和個人資訊。
- **提出改進：** 說明問題及社群效益；重大修改先在 Issue 討論。
- **提交 Pull Request：** 保持範圍集中、連結相關 Issue，說明修改內容與測試方法。
- **其他協助：** 改善文件、測試、開發附加元件，或在 Console 提出翻譯修正。

問題與構想歡迎到 [Discord 社群](https://discord.gg/duneawakeningdocker)討論。

## 致謝與授權

由 RedBlink 主導並維護，社群共同貢獻。分享及散布時請註明 RedBlink 為原始開發者。

**免費開源，採用 [MIT 授權](../../LICENSE)。**
