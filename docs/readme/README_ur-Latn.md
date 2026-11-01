<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · **Roman Urdu** · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console, Linux, Windows/WSL2 aur virtual machines ke liye Docker par mabni Dune: Awakening dedicated server manager hai. Rehnumai ke saath installation aur browser panel se players, maps, backups, updates aur server ke kaam sambhalein.

Yeh community ka ghair rasmi project hai; Funcom se koi talluq, tasdeeq, sponsorship ya support nahin. Project tajribati hai aur Funcom ki self-hosting ka rawayya badal sakta hai.

## Aap Kya Kar Sakte Hain

- **Install aur Operate Karein:** Browser setup, updates, services ka control, scheduled restarts, restart queue, tashkhees aur recovery.
- **Live Dekhein:** Interactive maps, players aur vehicles ki tracking, resources, server health, performance aur logs.
- **Arrakis Sambhalein:** Maps, Sietches, Deep Desert layouts, automatic scaling, memory, game settings aur **tajribati Regis Tanks**.
- **Players Manage Karein:** Players aur guild tools, inventory, progress, bases, storage, vehicles, Landsraad, rewards aur Care Packages.
- **Economy Sambhalein:** Exchange listings dekhein aur built-in Market Bot se trading automatic karein.
- **Server Mehfooz Rakhein:** Database aur encrypted system backups, restore, migration, access roles, mehdood ijazat wali API keys aur encrypted API access.
- **Banayein aur Share Karein:** 3D base design, blueprints import aur share, public server profile aur latency tests.
- **Apni Pasand se Dhalain:** Community Addons, Discord integration, mukhtalif zubanein aur community translation corrections.

Command apne haath mein lein aur apna control center dekhein! Sample data ke saath [Console Azmayein](https://try.dunedocker.app/) — install karne ki zaroorat nahi.

## Zarooriyat

Linux expert hona zaroori nahin. Installer bunyadi sharaait check karta aur supported Linux par Docker tayyar karta hai.

| Cheez | Tajweez |
|---|---|
| Server | Naya 64-bit Ubuntu sab se asaan hai. Doosre Linux, Windows/WSL2 par Docker Desktop aur virtual machines bhi supported hain. |
| Docker | Supported Linux par na ho to installer tayyar karta hai. |
| CPU | AVX/AVX2 support |
| Memory | Shuru mein 20 GB RAM; mazeed hamesha chalte maps ke liye 30–40 GB ya zyada |
| Storage | 200 GB ya zyada |
| Funcom Token | Browser setup mein mehfooz tareeqe se enter hota hai |

<details>
<summary>RAM aur CPU ki Rehnumai</summary>

RAM tay karti hai ke kitne maps araam se chalenge. Basic layout se shuru karein, phir hamesha chalte maps aur players ki activity ke mutabiq barhayein. Official Survival baghair players bhi taqreeban 10–12 GB resident memory rakhta hai; aik idle reading memory leak ka saboot nahin. `docker stats` mein `100%` aik logical CPU ka poora istemal hai.

| Layout | Tajweez Shuda RAM |
|---|---:|
| Basic server | 20 GB |
| Main world aur extra story/social maps | 30 GB |
| Main world, extra maps aur Deep Desert | 40 GB |
| Bohat se hamesha chalte maps ya zyada activity | 60 GB+ |

</details>

Public internet hosting ke liye yeh ports forward karein:

| Port | Protocol | Maqsad |
|---|---|---|
| `8088` | TCP | Web admin, sirf bharosemand administrators |
| `31982` | TCP | RabbitMQ game messaging endpoint |
| `31983` | TCP | RabbitMQ game HTTP endpoint |
| `7777-7810` | UDP | Game traffic |
| `32000-32015` | UDP | Ikhtiyari direct latency tests; band hon to relay mojood hai |
| `8797` | TCP | Ikhtiyari HTTPS API; [Encrypted API Access](../console/encrypted-api.md) |

Database aur internal admin ports private rakhein. Web UI ghair bharosemand users ko na dein.

## Installation

`sudo` wala aam account use karein, `root` login nahin. Installer sirf zaroorat par admin ijazat maangta hai. Naye Linux par chalayein:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

Installer latest release download karta, web panel chalata aur address batata hai. Baqi setup browser mein karein. Default path `~/dune-awakening-selfhost-docker` hai. Doosri disk ke liye poora destination dein:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Windows par supported Linux VM ya Ubuntu WSL2 terminal use karein, PowerShell, Command Prompt ya Docker Desktop ki internal shell nahin. Extract se pehle writing aur space check hoti hai; nakaam download installation ko adhoora overwrite nahin karta.

Alpine Linux distribution ke Docker/Docker Compose packages aur OpenRC use karta hai. community repository na ho to settings badalne se pehle ijazat li jati hai.

## Public Server Directory

[DuneDocker.app](https://dunedocker.app/) communities ko numayan aur players ko server dhoondhne mein madad deta hai. Live page par status, player count, region, Sietches, zaati latency aur ikhtiyari Discord link hota hai.

Console Settings se listing claim karke ownership verify karein, profile aur Discord invite manage karein aur server promote karein. Listing kabhi bhi on/off ki ja sakti hai.

Direct measurement UDP `32000-32015` use karti hai; host firewall, internet–DMZ firewall aur NAT par allow karein. Band ho to compatibility barqarar rehti hai aur Dune Docker relay khud istemal hota hai.

Local aur sirf LAN servers kabhi list nahin hote. Default mein sirf anonymous server count share hota hai, naam, address, players ya settings nahin. Is count ko Settings mein alag band kar sakte hain.

## Base Builder

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) browser mein 3D base planning aur sharing ka tool hai. Game mein waqt aur material lagane se pehle searchable catalog, placement, snapping, rotation, collision aur territory coverage se design azmayein.

Angles aur day/night badlein, andar chal kar dekhein, screenshots lein, layouts import aur designs export karein. Login ke baad save, public/unlisted/private visibility, previews publish, community designs dekhna aur published blueprint copy karna mumkin hai. Console footer mein bhi link hai.

## Community Addons

Web UI se ikhtiyari tools install aur manage karein. Permissions pehle batayi jati hain; updates settings rakhte aur nayi permissions ki approval maangte hain. Developers [Official Addon Template](https://github.com/Red-Blink/dune-docker-addon-template) se shuru kar sakte hain.

## Madad aur Documentation

- [Official Website](https://dunedocker.app/) — Project, installation, FAQ aur directory
- [Base Builder](https://blueprints.dunedocker.app/) — 3D plan, preview, save aur share
- [Official Documentation](https://docs.dunedocker.app/) — Guides, features, technical aur API references
- [Discord Community](https://discord.gg/duneawakeningdocker) — Support, updates, addons aur guftagu
- [Repository Documentation](../README.md) — Code ke saath technical notes
- [Project ki Madad Karein](https://ko-fi.com/redblink) — Development, testing aur infrastructure

## Hissa Lein

Developers, server owners aur players ko khush aamdeed. Kaam dohrane se bachne ke liye [issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) aur [pull requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) dekhein.

- **Bug Report Karein:** Version, reproduce karne ke qadam aur expected result; logs aur images se passwords aur zaati maloomat hata dein.
- **Behtari Batayein:** Masla aur faida samjhayein; bari tabdeeli pehle issue mein discuss karein.
- **Pull Request Bhejein:** Tabdeeli focused rakhein, related issues link aur changes/tests wazeh karein.
- **Code ke Ilawa:** Docs, tests, addons ya Console mein translation correction ki tajweez dein.

Sawalat aur ideas [Discord Community](https://discord.gg/duneawakeningdocker) mein share karein.

## Credits aur License

RedBlink community ki madad se project ki rehnumai aur dekh bhaal karta hai. Share ya redistribute karte waqt RedBlink ko asal developer ka credit dein.

**[MIT License](../../LICENSE) ke tehat muft aur open source.**
