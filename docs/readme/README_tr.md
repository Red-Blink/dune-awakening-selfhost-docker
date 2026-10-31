<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · **Türkçe** · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console; Linux, Windows/WSL2 ve sanal makineler için Docker tabanlı bir Dune: Awakening özel sunucu yöneticisidir. Yönlendirmeli kurulum ve tarayıcı paneliyle oyuncuları, haritaları, yedekleri, güncellemeleri ve sunucu işlemlerini yönetebilirsiniz.

Funcom ile bağlantısı, onayı, sponsorluğu veya desteği bulunmayan gayriresmî bir topluluk projesidir. Proje deneyseldir; Funcom'un kendi sunucunuzu barındırma davranışı zamanla değişebilir.

## Neler Yapabilirsiniz

- **Kurun ve İşletin:** Tarayıcıdan kurulum, güncellemeler, hizmet kontrolü, zamanlanmış yeniden başlatmalar, yeniden başlatma kuyruğu, tanılama ve kurtarma.
- **Canlı İzleyin:** Etkileşimli dünya haritaları, oyuncu ve araç takibi, kaynak konumları, sunucu sağlığı, performans ve günlükler.
- **Arrakis'i Yönetin:** Haritalar, Sietch'ler, Deep Desert düzenleri, otomatik ölçekleme, bellek, oyun ayarları ve **deneysel Regis Tanks**.
- **Oyuncuları Yönetin:** Oyuncu ve lonca araçları, envanter, ilerleme, üsler, depolar, araçlar, Landsraad, ödüller ve Care Packages.
- **Ekonomiyi Yönetin:** Exchange ilanlarını inceleyin ve yerleşik Market Bot ile ticareti otomatikleştirin.
- **Sunucunuzu Koruyun:** Veritabanı ve şifreli sistem yedekleri, geri yükleme, taşıma, erişim rolleri, izin kapsamı belirlenmiş API anahtarları ve şifreli API erişimi.
- **İnşa Edin ve Paylaşın:** 3B üs tasarımı, plan içe aktarma ve paylaşma, herkese açık sunucu profili ve gecikme ölçümü.
- **Özelleştirin:** Topluluk eklentileri, Discord entegrasyonu, çok dilli Console ve topluluk çeviri düzeltmeleri.

[Ekran Görüntüleri](../screenshots.md) sayfasına göz atın.

## Gereksinimler

Linux uzmanı olmanız gerekmez. Kurucu temel koşulları denetler ve desteklenen Linux sistemlerinde Docker'ı hazırlar.

| Gereksinim | Öneri |
|---|---|
| Sunucu | Yeni kurulmuş 64 bit Ubuntu en kolay seçenektir. Diğer Linux dağıtımları, Windows/WSL2 üzerinde Docker Desktop ve sanal makineler de desteklenir. |
| Docker | Desteklenen Linux sisteminde yoksa kurucu hazırlar. |
| İşlemci | AVX/AVX2 desteği |
| Bellek | Başlangıç için 20 GB RAM; ek sürekli açık haritalar için 30–40 GB veya üzeri |
| Depolama | 200 GB veya üzeri |
| Funcom Belirteci | Tarayıcı kurulumu sırasında güvenle girilir |

<details>
<summary>Bellek ve İşlemci Rehberi</summary>

Çalışabilecek harita sayısını RAM belirler. Temel düzenle başlayıp sürekli açık haritalar ve oyuncu yoğunluğu için artırın. Resmî Survival sunucusu oyuncu yokken bile yaklaşık 10–12 GB yerleşik bellek kullanabilir; tek boşta ölçüm bellek sızıntısı kanıtı değildir. `docker stats` içinde `100%`, bir mantıksal işlemcinin tamamen kullanılmasıdır.

| Düzen | Önerilen RAM |
|---|---:|
| Temel başlangıç sunucusu | 20 GB |
| Ana dünya ve ek hikâye/sosyal haritalar | 30 GB |
| Ana dünya, ek haritalar ve Deep Desert | 40 GB |
| Çok sayıda sürekli açık harita veya yoğun oyuncu etkinliği | 60 GB+ |

</details>

İnternete açık sunucularda şu portları yönlendirin:

| Port | Protokol | Amaç |
|---|---|---|
| `8088` | TCP | Web yönetimi; yalnızca güvenilir yöneticiler |
| `31982` | TCP | RabbitMQ oyun mesajlaşma uç noktası |
| `31983` | TCP | RabbitMQ oyun HTTP uç noktası |
| `7777-7810` | UDP | Oyun trafiği |
| `32000-32015` | UDP | İsteğe bağlı doğrudan dizin gecikme ölçümü; kapalıysa aktarıcı kullanılabilir |
| `8797` | TCP | İsteğe bağlı HTTPS API; [Şifreli API Erişimi](../console/encrypted-api.md) |

Veritabanı ve iç yönetim portlarını gizli tutun. Web arayüzünü güvenilmeyen kullanıcılara açmayın.

## Kurulum

`root` olarak giriş yapmak yerine `sudo` yetkili normal hesap kullanın; yönetici erişimi yalnızca gerektiğinde istenir. Yeni Linux sunucusunda çalıştırın:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

Kurucu son sürümü indirir, web arayüzünü başlatır ve adresini gösterir. Kurulumu tarayıcıda tamamlayın. Varsayılan yol `~/dune-awakening-selfhost-docker` şeklindedir. Başka disk için tam hedef belirtin:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Windows'ta desteklenen Linux sanal makinesi veya Ubuntu WSL2 terminalini kullanın; PowerShell, Komut İstemi veya Docker Desktop'ın iç kabuğunu kullanmayın. Çıkarmadan önce yazma izni ve boş alan denetlenir; başarısız indirme kurulumu kısmen değiştirmez.

Alpine Linux'ta dağıtımın Docker ve Docker Compose paketleri, başlatmak için OpenRC kullanılır. community deposu yoksa yapılandırma değişikliği öncesinde izin istenir.

## Herkese Açık Sunucu Dizini

[DuneDocker.app](https://dunedocker.app/) toplulukları tanıtır ve oyuncuların sunucu bulmasına yardımcı olur. Canlı sayfalarda durum, oyuncu sayısı, bölge, Sietch'ler, kişisel gecikme ve isteğe bağlı Discord bağlantısı bulunur.

Console Ayarları'ndan kaydı sahiplenerek mülkiyeti doğrulayabilir, profil ve Discord davetini yönetebilir, sunucuyu tanıtabilirsiniz. Listeleme her zaman açılıp kapatılabilir.

Doğrudan ölçüm için UDP `32000-32015` aralığını ana makine güvenlik duvarında, internet–DMZ güvenlik duvarında ve NAT yönlendirmesinde açın. Kapalı sunucular otomatik Dune Docker aktarıcısıyla uyumlu kalır.

Yerel ve yalnızca LAN sunucuları listelenmez. Varsayılan katkı yalnızca anonim sunucu sayısıdır; ad, adres, oyuncu veya ayar içermez ve Ayarlar'dan ayrıca kapatılabilir.

## Üs Tasarım Aracı

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) tarayıcıda 3B üs planlama ve paylaşma sunar. Oyunda malzeme ve zaman harcamadan önce aranabilir yapı kataloğu, yerleştirme, hizalama, döndürme, çarpışma ve arazi kapsama araçlarıyla deneyin.

Farklı açılar, gündüz/gece, yürüyüş, ekran görüntüsü, mevcut düzenleri içe aktarma ve tasarım dışa aktarma desteklenir. Giriş yapanlar projeleri kaydedebilir; herkese açık, listelenmeyen veya özel görünürlük seçebilir; önizleme yayımlayabilir, topluluk tasarımlarını inceleyip yayımlanmış planları kopyalayabilir. Console altbilgisinden de erişilebilir.

## Topluluk Eklentileri

İsteğe bağlı araçları web arayüzünden kurup yönetin. İzinler kurulum öncesi bildirilir, güncellemeler ayarları korur ve yeni izinler onay gerektirir. Geliştiriciler [Resmî Eklenti Şablonu](https://github.com/Red-Blink/dune-docker-addon-template) ile başlayabilir.

## Yardım ve Belgeler

- [Resmî Site](https://dunedocker.app/) — Proje, kurulum, SSS ve sunucu dizini
- [Üs Tasarım Aracı](https://blueprints.dunedocker.app/) — 3B planlama, önizleme, kayıt ve paylaşım
- [Resmî Belgeler](https://docs.dunedocker.app/) — Rehberler, özellikler, teknik ve API başvuruları
- [Discord Topluluğu](https://discord.gg/duneawakeningdocker) — Destek, güncellemeler, eklentiler ve tartışma
- [Depo Belgeleri](../README.md) — Kaynak kodla birlikte tutulan teknik notlar
- [Projeyi Destekleyin](https://ko-fi.com/redblink) — Geliştirme, test ve altyapıya katkı

## Katkıda Bulunma

Geliştiriciler, sunucu sahipleri ve oyuncular katkıda bulunabilir. Tekrarı önlemek için mevcut [sorunları](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) ve [çekme isteklerini](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) inceleyin.

- **Hata Bildirin:** Sürüm, tekrar adımları ve beklenen sonucu yazın; günlük ve görüntülerden parola ve kişisel bilgileri çıkarın.
- **İyileştirme Önerin:** Sorunu ve topluluk yararını açıklayın. Büyük değişiklikleri önce bir sorun kaydında tartışın.
- **Çekme İsteği Gönderin:** Değişiklikleri odaklı tutun, ilgili sorunları bağlayın, yapılanı ve testleri açıklayın.
- **Kod Dışında Yardım Edin:** Belge, test, eklenti veya Console üzerinden çeviri düzeltmeleriyle katkı sağlayın.

Sorular ve fikirler için [Discord Topluluğu](https://discord.gg/duneawakeningdocker) sizi bekliyor.

## Emeği Geçenler ve Lisans

RedBlink, topluluğun katkılarıyla projeyi yönetir ve sürdürür. Paylaşırken veya yeniden dağıtırken özgün geliştirici olarak RedBlink'i belirtin.

**[MIT Lisansı](../../LICENSE) altında ücretsiz ve açık kaynaklıdır.**
