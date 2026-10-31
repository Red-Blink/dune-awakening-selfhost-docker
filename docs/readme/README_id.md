<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · **Bahasa Indonesia** · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending-daily.svg" alt="Dune Awakening Community — Daily Top Repository" width="280" height="79">
  <img src="../../assets/community-trending-weekly.svg" alt="Dune Awakening Community — Weekly Top Repository" width="280" height="79">
  <img src="../../assets/community-trending-monthly.svg" alt="Dune Awakening Community — Monthly Top Repository" width="280" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console adalah pengelola server khusus Dune: Awakening berbasis Docker untuk Linux, Windows/WSL2, dan mesin virtual. Instalasi terpandu dan panel peramban membantu mengelola pemain, peta, cadangan, pembaruan, dan operasional server.

Proyek komunitas tidak resmi ini tidak berafiliasi, disetujui, disponsori, atau didukung Funcom. Proyek masih eksperimental; perilaku hosting mandiri Funcom dapat berubah.

## Yang Bisa Anda Lakukan

- **Pasang dan Operasikan:** Penyiapan di peramban, pembaruan, kontrol layanan, jadwal dan antrean mulai ulang, diagnosis, serta pemulihan.
- **Pantau Langsung:** Peta interaktif, pelacakan pemain dan kendaraan, lokasi sumber daya, kesehatan server, kinerja, dan log.
- **Atur Arrakis:** Peta, Sietch, tata letak Deep Desert, penskalaan otomatis, memori, pengaturan permainan, dan **Regis Tanks eksperimental**.
- **Kelola Pemain:** Peralatan pemain dan guild, inventaris, progres, markas, penyimpanan, kendaraan, Landsraad, hadiah, dan Care Packages.
- **Kelola Ekonomi:** Telusuri penawaran Exchange dan otomatiskan perdagangan dengan Market Bot bawaan.
- **Lindungi Server:** Cadangan basis data dan cadangan sistem terenkripsi, pemulihan, migrasi, peran akses, kunci API dengan izin terbatas, dan API terenkripsi.
- **Bangun dan Bagikan:** Rancang markas 3D, impor dan bagikan cetak biru, tampilkan profil server publik dan uji latensi.
- **Sesuaikan:** Addon komunitas, integrasi Discord, berbagai bahasa Console, dan perbaikan terjemahan komunitas.

Lihat [Galeri Tangkapan Layar](../screenshots.md).

## Persyaratan

Tidak perlu ahli Linux. Pemasang memeriksa dasar-dasarnya dan menyiapkan Docker pada Linux yang didukung.

| Kebutuhan | Rekomendasi |
|---|---|
| Server | Ubuntu 64-bit baru adalah pilihan termudah. Linux lain, Docker Desktop pada Windows/WSL2, dan mesin virtual juga didukung. |
| Docker | Disiapkan pemasang jika belum tersedia pada Linux yang didukung. |
| CPU | Dukungan AVX/AVX2 |
| Memori | Mulai 20 GB RAM; 30–40 GB atau lebih untuk peta tambahan yang selalu aktif |
| Penyimpanan | 200 GB atau lebih |
| Token Funcom | Dimasukkan dengan aman saat penyiapan di peramban |

Host SELinux seperti Fedora dan Bazzite memakai label mount proyek bersama. Pembatasan label dinonaktifkan hanya untuk Console yang membutuhkan soket Docker host; SELinux host, label dan izin soket tetap sama. Setelah peningkatan jalankan `dune console reload`. Pasang Docker terlebih dahulu jika pemasang otomatis Docker tidak mendukung distribusi Anda.

<details>
<summary>Panduan RAM dan CPU</summary>

RAM menentukan jumlah peta yang berjalan nyaman. Mulai dengan tata letak dasar lalu tambah sesuai peta permanen dan aktivitas pemain. Survival resmi biasanya memakai sekitar 10–12 GB memori residen meski kosong; satu pengukuran menganggur bukan bukti kebocoran. Dalam `docker stats`, `100%` berarti satu CPU logis terpakai penuh.

| Tata Letak | RAM Disarankan |
|---|---:|
| Server dasar | 20 GB |
| Dunia utama dan peta cerita/sosial | 30 GB |
| Dunia utama, peta tambahan, dan Deep Desert | 40 GB |
| Banyak peta permanen atau aktivitas tinggi | 60 GB+ |

</details>

Untuk hosting internet publik, teruskan port berikut:

| Port | Protokol | Fungsi |
|---|---|---|
| `8088` | TCP | Admin web; hanya administrator tepercaya |
| `31982` | TCP | Endpoint pesan permainan RabbitMQ |
| `31983` | TCP | Endpoint HTTP permainan RabbitMQ |
| `7777-7810` | UDP | Lalu lintas permainan |
| `32000-32015` | UDP | Uji latensi langsung opsional; relay tersedia saat ditutup |
| `8797` | TCP | API HTTPS opsional; [Akses API Terenkripsi](../console/encrypted-api.md) |

Jaga port basis data dan admin internal tetap privat. Jangan buka antarmuka web bagi pengguna tak tepercaya.

## Instalasi

Gunakan akun biasa dengan `sudo`, bukan login sebagai `root`. Hak admin hanya diminta saat perlu. Pada Linux baru jalankan:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

Pemasang mengunduh rilis terbaru, memulai antarmuka web, dan menunjukkan alamat. Selesaikan di peramban. Lokasi bawaan adalah `~/dune-awakening-selfhost-docker`. Untuk disk lain, tentukan tujuan lengkap:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Pada Windows gunakan terminal Linux VM yang didukung atau Ubuntu WSL2, bukan PowerShell, Command Prompt, atau shell internal Docker Desktop. Izin tulis dan ruang diperiksa sebelum ekstraksi; unduhan gagal tidak menimpa instalasi sebagian.

Alpine Linux memakai paket Docker/Docker Compose distribusi serta OpenRC. Jika repositori community tidak tersedia, pemasang meminta izin sebelum mengubah konfigurasinya.

## Direktori Server Publik

[DuneDocker.app](https://dunedocker.app/) memperkenalkan komunitas dan membantu pemain menemukan server. Halaman langsung menampilkan status, jumlah pemain, wilayah, Sietch, latensi pribadi, serta Discord opsional.

Klaim daftar melalui Pengaturan Console untuk memverifikasi kepemilikan, mengelola profil dan undangan Discord, serta mempromosikan server. Publikasi dapat diubah kapan saja.

Pengukuran langsung memakai UDP `32000-32015`; izinkan pada firewall host, firewall internet–DMZ, dan NAT. Jika tertutup, server tetap kompatibel dan otomatis memakai relay Dune Docker.

Server lokal dan khusus LAN tidak pernah ditampilkan. Secara bawaan hanya jumlah server anonim yang dibagikan, tanpa nama, alamat, pemain, atau pengaturan. Penghitungan ini dapat dimatikan terpisah di Pengaturan.

## Perancang Markas

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) menyediakan perencanaan dan berbagi markas 3D di peramban. Uji sebelum menghabiskan waktu dan material dalam permainan dengan katalog yang bisa dicari, penempatan, snapping, rotasi, tabrakan, serta cakupan wilayah.

Ubah sudut dan siang/malam, jelajahi rancangan, ambil gambar, impor tata letak, dan ekspor desain. Setelah login, simpan proyek, pilih publik/tidak terdaftar/privat, terbitkan pratinjau, jelajahi dan salin cetak biru komunitas. Tautannya juga ada di footer Console.

## Addon Komunitas

Pasang dan kelola alat opsional dari web. Izin dinyatakan sebelum instalasi; pembaruan mempertahankan pengaturan dan memerlukan persetujuan izin baru. Pengembang dapat memakai [Templat Addon Resmi](https://github.com/Red-Blink/dune-docker-addon-template).

## Bantuan dan Dokumentasi

- [Situs Resmi](https://dunedocker.app/) — Proyek, instalasi, FAQ, dan direktori
- [Perancang Markas](https://blueprints.dunedocker.app/) — Rencana, pratinjau, simpan, dan bagikan 3D
- [Dokumentasi Resmi](https://docs.dunedocker.app/) — Panduan, fitur, teknis, dan API
- [Discord](https://discord.gg/duneawakeningdocker) — Bantuan, pembaruan, addon, dan diskusi
- [Dokumentasi Repositori](../README.md) — Catatan teknis bersama kode sumber
- [Dukung Proyek](https://ko-fi.com/redblink) — Pengembangan, pengujian, dan infrastruktur

## Berkontribusi

Pengembang, pemilik server, dan pemain dipersilakan. Periksa [issue](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) serta [pull request](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) agar tidak menduplikasi pekerjaan.

- **Laporkan Bug:** Cantumkan versi, langkah reproduksi, dan hasil yang diharapkan; hapus sandi dan data pribadi dari log/gambar.
- **Usulkan Perbaikan:** Jelaskan masalah dan manfaat; diskusikan perubahan besar dalam issue terlebih dahulu.
- **Kirim Pull Request:** Jaga fokus, tautkan issue, jelaskan perubahan dan pengujian.
- **Bantu Selain Kode:** Dokumentasi, pengujian, addon, atau koreksi terjemahan dari Console.

Pertanyaan dan ide dapat dibahas di [Discord](https://discord.gg/duneawakeningdocker).

## Kredit dan Lisensi

RedBlink memimpin dan memelihara proyek dengan kontribusi komunitas. Sebutkan RedBlink sebagai pengembang asli saat membagikan atau mendistribusikan ulang.

**Gratis dan sumber terbuka di bawah [Lisensi MIT](../../LICENSE).**
