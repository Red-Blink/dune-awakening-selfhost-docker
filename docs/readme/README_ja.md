<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · **日本語** · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console は、Linux、Windows/WSL2、仮想マシンに対応した Docker ベースの Dune: Awakening 専用サーバー管理ツールです。案内に沿ったインストールとブラウザー管理画面で、プレイヤー、マップ、バックアップ、更新、サーバー運用を管理できます。

Funcom との提携、承認、出資、サポートを受けていない非公式コミュニティプロジェクトです。実験段階のため、Funcom のセルフホストの動作は今後変わる可能性があります。

## できること

- **導入と運用：** ブラウザーでの初期設定、更新、サービス制御、再起動の予約とキュー、診断、復旧。
- **リアルタイム監視：** インタラクティブな世界地図、プレイヤーと車両の追跡、資源の位置、サーバー状態、性能、ログ。
- **アラキスの設定：** マップ、Sietch、Deep Desert の構成、自動スケーリング、メモリ、ゲーム設定、**実験的な Regis Tanks**。
- **プレイヤー管理：** プレイヤーとギルド、所持品、進行状況、基地、倉庫、車両、Landsraad、報酬、Care Packages。
- **経済の運用：** Exchange の出品閲覧と、内蔵 Market Bot による自動取引。
- **サーバー保護：** データベースと暗号化システムバックアップ、復元と移行、アクセスロール、権限を限定した API キー、暗号化 API。
- **建築と共有：** 3D 基地設計、設計図のインポートと共有、公開サーバープロフィールと遅延測定。
- **カスタマイズ：** コミュニティアドオン、Discord 連携、多言語表示、コミュニティによる翻訳修正。

自分だけの司令室を操作してみましょう！インストール不要で、サンプルデータを使って[コンソールを試せます](https://try.dunedocker.app/)。

## 動作要件

Linux の専門知識は不要です。インストーラーが基本条件を確認し、対応 Linux で Docker を準備します。

| 項目 | 推奨 |
|---|---|
| サーバー | 新規の 64 ビット Ubuntu が最も簡単です。他の Linux、Windows/WSL2 の Docker Desktop、仮想マシンにも対応。 |
| Docker | 対応 Linux では未導入の場合にインストーラーが準備します。 |
| CPU | AVX/AVX2 対応 |
| メモリ | 最低目安 20 GB RAM、常時稼働マップを増やす場合は 30–40 GB 以上 |
| ストレージ | 200 GB 以上 |
| Funcom トークン | ブラウザーの設定時に安全に入力 |

<details>
<summary>メモリと CPU の目安</summary>

RAM に応じて無理なく動かせるマップ数が変わります。基本構成から始め、常時稼働マップやプレイヤーの活動に合わせて増設してください。公式 Survival サーバーは無人でも常駐メモリが約 10–12 GB になることがあります。待機中の一度の測定だけでメモリリークとは判断できません。`docker stats` の `100%` は論理 CPU 1 個の全使用を表します。

| 構成 | 推奨 RAM |
|---|---:|
| 基本の入門サーバー | 20 GB |
| メイン世界と追加のストーリー／交流マップ | 30 GB |
| メイン世界、追加マップ、Deep Desert | 40 GB |
| 多数の常時稼働マップや活発なプレイヤー | 60 GB+ |

</details>

インターネットに公開する場合は次のポートを転送します。

| ポート | プロトコル | 用途 |
|---|---|---|
| `8088` | TCP | 管理画面。信頼できる管理者のみ許可 |
| `31982` | TCP | RabbitMQ ゲームメッセージエンドポイント |
| `31983` | TCP | RabbitMQ ゲーム HTTP エンドポイント |
| `7777-7810` | UDP | ゲーム通信 |
| `32000-32015` | UDP | 公開ディレクトリの任意の直接遅延測定。閉じている場合は中継を使用 |
| `8797` | TCP | 任意の HTTPS API。[暗号化 API アクセス](../console/encrypted-api.md)を参照 |

データベースと内部管理ポートは公開せず、信頼できないユーザーに管理画面を公開しないでください。

## インストール

`root` でログインせず、`sudo` が使える一般ユーザーで実行してください。管理権限は必要時のみ求められます。新規 Linux サーバーで実行：

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

最新リリースを取得して管理画面を起動し、接続先を表示します。残りはブラウザーで設定します。既定の保存先は `~/dune-awakening-selfhost-docker`。別のディスクを使う場合は完全なパスを指定します。

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Windows では対応 Linux VM または Ubuntu WSL2 の端末を使い、PowerShell、コマンドプロンプト、Docker Desktop 内部シェルでは実行しないでください。展開前に書き込み権限と空き容量を確認し、ダウンロード失敗で既存環境が部分的に上書きされることはありません。

Alpine Linux ではディストリビューションの Docker と Docker Compose パッケージおよび OpenRC を使用します。community リポジトリが使えない場合、設定変更前に確認します。

## 公開サーバーディレクトリ

[DuneDocker.app](https://dunedocker.app/) はコミュニティの紹介とサーバー探しを支援します。公開ページには現在の状態、人数、地域、Sietch、利用者ごとの遅延、任意の Discord リンクが表示されます。

Console の設定で所有権を確認し、公開プロフィールや Discord 招待を管理して紹介できます。掲載はいつでも切り替えられます。

直接遅延測定は UDP `32000-32015` を使用します。ホストとインターネットから DMZ へのファイアウォール、および NAT 転送で許可してください。非公開でも互換性は保たれ、自動的に Dune Docker 中継を使います。

ローカル／LAN 専用サーバーは掲載しません。既定では匿名のサーバー台数のみ集計し、名前、アドレス、プレイヤー、設定は送りません。この集計も設定で個別に無効化できます。

## 基地ビルダー

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) はブラウザーで基地を 3D 設計・共有するツールです。ゲーム内で時間と素材を使う前に、検索可能な建築カタログ、配置、スナップ、回転、衝突、領地範囲の機能で構成を試せます。

視点や昼夜の切り替え、内部の歩行、撮影、既存配置のインポート、完成図のエクスポートが可能です。ログインすると保存、公開・限定公開・非公開の選択、プレビュー公開、作品の閲覧、公開設計図の複製ができます。Console のフッターにもリンクがあります。

## コミュニティアドオン

任意のツールを管理画面から導入・管理できます。導入前に権限が表示され、更新は設定を保ち、新しい権限は承認を求めます。開発には[公式アドオンテンプレート](https://github.com/Red-Blink/dune-docker-addon-template)を使えます。

## ヘルプとドキュメント

- [公式サイト](https://dunedocker.app/) — 概要、導入、よくある質問、サーバー一覧
- [基地ビルダー](https://blueprints.dunedocker.app/) — 3D 設計、確認、保存、共有
- [公式ドキュメント](https://docs.dunedocker.app/) — ガイド、機能、技術資料、API
- [Discord コミュニティ](https://discord.gg/duneawakeningdocker) — 支援、更新、アドオン、交流
- [リポジトリ資料](../README.md) — ソースとともに管理する技術資料
- [プロジェクト支援](https://ko-fi.com/redblink) — 開発、テスト、インフラへの支援

## 貢献するには

開発者、管理者、プレイヤーの参加を歓迎します。重複を避けるため、まず [Issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) と [Pull Requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) を確認してください。

- **不具合報告：** バージョン、再現手順、期待した動作を記載し、ログや画像からパスワードと個人情報を除いてください。
- **改善提案：** 解決する問題と利点を説明し、大きな変更は事前に Issue で相談してください。
- **Pull Request：** 変更を絞り、関連 Issue と変更点、テスト方法を記載してください。
- **コード以外の協力：** 資料改善、テスト、アドオン制作、Console からの翻訳修正提案も歓迎します。

質問や相談は [Discord コミュニティ](https://discord.gg/duneawakeningdocker)へ。

## クレジットとライセンス

RedBlink が主導・保守し、コミュニティが協力しています。共有や再配布の際は原作者として RedBlink を明記してください。

**無料・オープンソースの [MIT ライセンス](../../LICENSE)です。**
