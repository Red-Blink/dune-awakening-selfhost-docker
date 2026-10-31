<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · **فارسی** · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

<div dir="rtl">

Dune Docker Console ابزاری مبتنی بر Docker برای مدیریت سرور اختصاصی Dune: Awakening روی Linux، Windows/WSL2 و ماشین‌های مجازی است. نصب راهنما‌دار و پنل مرورگر، مدیریت بازیکنان، نقشه‌ها، پشتیبان‌ها، به‌روزرسانی و عملیات سرور را ساده می‌کند.

این پروژهٔ غیررسمی جامعه هیچ وابستگی، تأیید، حمایت مالی یا پشتیبانی از Funcom ندارد. پروژه آزمایشی است و رفتار میزبانی شخصی Funcom ممکن است تغییر کند.

## چه کارهایی می‌توانید انجام دهید

- **راه‌اندازی و اداره:** تنظیم در مرورگر، به‌روزرسانی، کنترل سرویس، زمان‌بندی و صف راه‌اندازی مجدد، عیب‌یابی و بازیابی.
- **نظارت زنده:** نقشه‌های تعاملی، ردیابی بازیکنان و وسایل نقلیه، منابع، سلامت سرور، کارایی و گزارش‌ها.
- **کنترل آراکیس:** نقشه‌ها، Sietchها، چیدمان Deep Desert، مقیاس‌گذاری خودکار، حافظه، تنظیمات بازی و **Regis Tanks آزمایشی**.
- **مدیریت بازیکنان:** ابزار بازیکنان و انجمن‌ها، موجودی، پیشرفت، پایگاه‌ها، انبار، وسایل نقلیه، Landsraad، پاداش و Care Packages.
- **ادارهٔ اقتصاد:** مشاهدهٔ آگهی‌های Exchange و معاملهٔ خودکار با Market Bot داخلی.
- **حفاظت از سرور:** پشتیبان پایگاه داده و پشتیبان رمزگذاری‌شدهٔ سیستم، بازیابی، انتقال، نقش‌های دسترسی، کلیدهای API با مجوز محدود و API رمزگذاری‌شده.
- **ساخت و اشتراک:** طراحی سه‌بعدی پایگاه، ورود و اشتراک نقشه‌های ساخت، نمایهٔ عمومی سرور و سنجش تأخیر.
- **شخصی‌سازی:** افزونه‌های جامعه، Discord، زبان‌های متعدد و اصلاح ترجمه با مشارکت کاربران.

فرمان را به دست بگیرید و مرکز کنترل خود را کشف کنید! [کنسول را امتحان کنید](https://try.dunedocker.app/)؛ با داده‌های نمونه و بدون نیاز به نصب.

## پیش‌نیازها

لازم نیست متخصص Linux باشید. نصب‌کننده شرایط اولیه را بررسی و Docker را روی Linuxهای پشتیبانی‌شده آماده می‌کند.

| مورد | پیشنهاد |
|---|---|
| سرور | Ubuntu تازه‌نصب‌شدهٔ ۶۴ بیتی ساده‌ترین گزینه است. Linuxهای دیگر، Docker Desktop روی Windows/WSL2 و ماشین مجازی هم پشتیبانی می‌شوند. |
| Docker | در Linux پشتیبانی‌شده، اگر موجود نباشد، نصب‌کننده آماده‌اش می‌کند. |
| CPU | پشتیبانی AVX/AVX2 |
| حافظه | شروع با 20 GB RAM؛ برای نقشه‌های دائمی بیشتر 30–40 GB یا بالاتر |
| ذخیره‌سازی | 200 GB یا بیشتر |
| توکن Funcom | ورود امن هنگام تنظیم در مرورگر |

<details>
<summary>راهنمای حافظه و پردازنده</summary>

RAM تعداد نقشه‌هایی را که روان اجرا می‌شوند تعیین می‌کند. با حالت پایه شروع و برای نقشه‌های دائمی یا فعالیت بیشتر حافظه اضافه کنید. Survival رسمی معمولاً حتی بدون بازیکن حدود 10–12 GB حافظهٔ مقیم دارد؛ یک اندازه‌گیری در حالت بیکار اثبات نشت حافظه نیست. در `docker stats` مقدار `100%` یعنی استفادهٔ کامل از یک CPU منطقی.

| چیدمان | RAM پیشنهادی |
|---|---:|
| سرور پایه | 20 GB |
| دنیای اصلی و نقشه‌های داستانی/اجتماعی | 30 GB |
| دنیای اصلی، نقشه‌های بیشتر و Deep Desert | 40 GB |
| نقشه‌های دائمی متعدد یا فعالیت زیاد | 60 GB+ |

</details>

برای میزبانی عمومی اینترنت، این درگاه‌ها را هدایت کنید:

| درگاه | پروتکل | کاربرد |
|---|---|---|
| `8088` | TCP | مدیریت وب، فقط مدیران مورد اعتماد |
| `31982` | TCP | پیام‌رسانی بازی RabbitMQ |
| `31983` | TCP | نقطهٔ HTTP بازی RabbitMQ |
| `7777-7810` | UDP | ترافیک بازی |
| `32000-32015` | UDP | سنجش مستقیم اختیاری تأخیر؛ با درگاه بسته واسط فعال است |
| `8797` | TCP | API اختیاری HTTPS؛ [دسترسی API رمزگذاری‌شده](../console/encrypted-api.md) |

درگاه‌های پایگاه داده و مدیریت داخلی را خصوصی نگه دارید. رابط وب را در اختیار کاربران نامطمئن نگذارید.

## نصب

از حساب معمولی دارای `sudo` استفاده کنید، نه ورود با `root`. مجوز مدیریت فقط هنگام نیاز درخواست می‌شود. روی Linux تازه اجرا کنید:

<div dir="ltr">

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

</div>

نصب‌کننده آخرین انتشار را دریافت کرده، رابط وب را راه می‌اندازد و نشانی را نمایش می‌دهد. در مرورگر ادامه دهید. مسیر پیش‌فرض `~/dune-awakening-selfhost-docker` است؛ برای دیسک دیگر مسیر کامل بدهید:

<div dir="ltr">

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

</div>

در Windows از پایانهٔ Linux VM پشتیبانی‌شده یا Ubuntu WSL2 استفاده کنید، نه PowerShell، Command Prompt یا پوستهٔ داخلی Docker Desktop. امکان نوشتن و فضای آزاد پیش از استخراج بررسی می‌شود؛ دریافت ناموفق نصب را نیمه‌بازنویسی نمی‌کند.

Alpine Linux از بسته‌های Docker و Docker Compose توزیع و OpenRC استفاده می‌کند. اگر مخزن community موجود نباشد، پیش از تغییر تنظیمات اجازه می‌گیرد.

## فهرست عمومی سرورها

[DuneDocker.app](https://dunedocker.app/) جامعه‌ها را معرفی و یافتن سرور را آسان می‌کند. صفحهٔ زنده شامل وضعیت، تعداد بازیکنان، منطقه، Sietchها، تأخیر شخصی و پیوند اختیاری Discord است.

از تنظیمات Console، مالکیت فهرست را تأیید، نمایه و دعوت Discord را مدیریت و سرور را معرفی کنید. نمایش عمومی هر زمان قابل تغییر است.

سنجش مستقیم از UDP `32000-32015` استفاده می‌کند؛ آن را در دیوارهٔ آتش میزبان، اینترنت–DMZ و NAT مجاز کنید. در غیر این صورت سرور همچنان سازگار است و خودکار از واسط Dune Docker استفاده می‌کند.

سرورهای محلی یا فقط LAN هرگز فهرست نمی‌شوند. پیش‌فرض فقط شمارش ناشناس سرورهاست؛ بدون نام، نشانی، بازیکن یا تنظیمات. این آمار نیز جداگانه در تنظیمات خاموش می‌شود.

## طراح پایگاه

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) ابزار مرورگری طراحی و اشتراک پایگاه سه‌بعدی است. پیش از صرف زمان و مواد در بازی، با فهرست جست‌وجوپذیر، جای‌گذاری، چفت‌شدن، چرخش، برخورد و پوشش قلمرو طرح را بیازمایید.

زاویه و روز/شب را عوض کنید، قدم بزنید، تصویر بگیرید، چیدمان وارد و طرح صادر کنید. پس از ورود، ذخیره، انتخاب عمومی/فهرست‌نشده/خصوصی، انتشار پیش‌نمایش، مرور و کپی طرح‌های جامعه ممکن است. پیوند در پایین Console نیز قرار دارد.

## افزونه‌های جامعه

ابزارهای اختیاری را از وب نصب و مدیریت کنید. مجوزها پیش از نصب اعلام می‌شوند؛ به‌روزرسانی تنظیمات را حفظ و برای مجوز جدید تأیید می‌خواهد. توسعه‌دهندگان می‌توانند از [قالب رسمی افزونه](https://github.com/Red-Blink/dune-docker-addon-template) استفاده کنند.

## راهنما و مستندات

- [وب‌سایت رسمی](https://dunedocker.app/) — پروژه، نصب، پرسش‌ها و فهرست سرورها
- [طراح پایگاه](https://blueprints.dunedocker.app/) — برنامه‌ریزی، نمایش، ذخیره و اشتراک سه‌بعدی
- [مستندات رسمی](https://docs.dunedocker.app/) — راهنماها، قابلیت‌ها، مراجع فنی و API
- [Discord](https://discord.gg/duneawakeningdocker) — پشتیبانی، اخبار، افزونه و گفت‌وگو
- [مستندات مخزن](../README.md) — نکات فنی همراه کد منبع
- [حمایت از پروژه](https://ko-fi.com/redblink) — توسعه، آزمایش و زیرساخت

## مشارکت

توسعه‌دهندگان، مالکان سرور و بازیکنان خوش‌آمدند. برای جلوگیری از تکرار، [گزارش‌ها](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) و [درخواست‌های ادغام](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) را ببینید.

- **گزارش خطا:** نسخه، مراحل و نتیجهٔ مورد انتظار؛ رمزها و اطلاعات شخصی را از گزارش و تصاویر حذف کنید.
- **پیشنهاد بهبود:** مشکل و فایده را شرح دهید؛ تغییر بزرگ را ابتدا در یک گزارش مطرح کنید.
- **درخواست ادغام:** تغییر متمرکز، پیوند گزارش مرتبط، توضیح تغییر و آزمایش.
- **کمک بدون کد:** مستندات، آزمایش، افزونه یا پیشنهاد اصلاح ترجمه در Console.

پرسش‌ها و ایده‌ها را در [Discord](https://discord.gg/duneawakeningdocker) مطرح کنید.

## سپاس و مجوز

RedBlink پروژه را با همکاری جامعه هدایت و نگهداری می‌کند. هنگام اشتراک یا بازتوزیع، RedBlink را به‌عنوان توسعه‌دهندهٔ اصلی ذکر کنید.

**رایگان و متن‌باز تحت [مجوز MIT](../../LICENSE).**

</div>
