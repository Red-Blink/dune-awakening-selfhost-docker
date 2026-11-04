<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · **ไทย** · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console เป็นเครื่องมือจัดการเซิร์ฟเวอร์เฉพาะของ Dune: Awakening ด้วย Docker สำหรับ Linux, Windows/WSL2 และเครื่องเสมือน มีตัวติดตั้งแบบแนะนำและหน้าเว็บสำหรับจัดการผู้เล่น แผนที่ สำรองข้อมูล อัปเดต และการทำงานของเซิร์ฟเวอร์

นี่คือโครงการชุมชนที่ไม่เป็นทางการ ไม่มีความเกี่ยวข้อง การรับรอง การสนับสนุนทางการเงิน หรือการช่วยเหลือจาก Funcom โครงการยังอยู่ในขั้นทดลอง และการโฮสต์เองของ Funcom อาจเปลี่ยนแปลงได้

## สิ่งที่คุณทำได้

- **ติดตั้งและดูแล:** ตั้งค่าผ่านเบราว์เซอร์ อัปเดต ควบคุมบริการ กำหนดเวลาและคิวรีสตาร์ต วินิจฉัยและกู้คืน
- **ติดตามสด:** แผนที่โต้ตอบ ติดตามผู้เล่นและยานพาหนะ ตำแหน่งทรัพยากร สถานะ ประสิทธิภาพ และบันทึก
- **ควบคุม Arrakis:** แผนที่ Sietch ผัง Deep Desert การปรับขนาดอัตโนมัติ หน่วยความจำ การตั้งค่าเกม และ **Regis Tanks แบบทดลอง**
- **จัดการผู้เล่น:** ผู้เล่น กิลด์ ช่องเก็บของ ความก้าวหน้า ฐาน ที่เก็บ ยานพาหนะ Landsraad รางวัล และ Care Packages
- **ดูแลเศรษฐกิจ:** ดูรายการ Exchange และซื้อขายอัตโนมัติด้วย Market Bot ในตัว
- **ปกป้องเซิร์ฟเวอร์:** สำรองฐานข้อมูลและระบบแบบเข้ารหัส กู้คืน ย้ายระบบ บทบาทการเข้าถึง คีย์ API จำกัดสิทธิ์ และ API เข้ารหัส
- **สร้างและแบ่งปัน:** ออกแบบฐาน 3D นำเข้าและแชร์พิมพ์เขียว โปรไฟล์สาธารณะและตรวจสอบความหน่วง
- **ปรับแต่ง:** ส่วนเสริมชุมชน เชื่อมต่อ Discord หลายภาษา และข้อเสนอแก้คำแปลจากชุมชน

รับหน้าที่ผู้บัญชาการแล้วสำรวจศูนย์ควบคุมของคุณ! [ลองใช้คอนโซล](https://try.dunedocker.app/)พร้อมข้อมูลตัวอย่าง โดยไม่ต้องติดตั้ง

## ข้อกำหนด

ไม่ต้องเชี่ยวชาญ Linux ตัวติดตั้งจะตรวจสอบพื้นฐานและเตรียม Docker บน Linux ที่รองรับ

| รายการ | คำแนะนำ |
|---|---|
| เซิร์ฟเวอร์ | Ubuntu 64 บิตที่ติดตั้งใหม่ใช้ง่ายที่สุด รองรับ Linux อื่น Docker Desktop บน Windows/WSL2 และเครื่องเสมือน |
| Docker | ตัวติดตั้งเตรียมให้หากยังไม่มีบน Linux ที่รองรับ |
| CPU | รองรับ AVX/AVX2 |
| หน่วยความจำ | เริ่มที่ 20 GB RAM; เพิ่มเป็น 30–40 GB ขึ้นไปสำหรับแผนที่เปิดตลอดเพิ่มเติม |
| ที่เก็บข้อมูล | 200 GB ขึ้นไป |
| โทเค็น Funcom | กรอกอย่างปลอดภัยระหว่างตั้งค่าในเบราว์เซอร์ |

<details>
<summary>คำแนะนำ RAM และ CPU</summary>

RAM กำหนดจำนวนแผนที่ที่รันได้อย่างเหมาะสม เริ่มจากผังพื้นฐานแล้วเพิ่มตามแผนที่เปิดตลอดและกิจกรรมผู้เล่น เซิร์ฟเวอร์ Survival ทางการมักใช้หน่วยความจำประจำประมาณ 10–12 GB แม้ไม่มีผู้เล่น การวัดขณะว่างครั้งเดียวไม่พิสูจน์ว่าหน่วยความจำรั่ว ใน `docker stats` ค่า `100%` คือใช้ CPU แบบลอจิคัลหนึ่งตัวเต็มที่

| ผัง | RAM แนะนำ |
|---|---:|
| เซิร์ฟเวอร์พื้นฐาน | 20 GB |
| โลกหลักและแผนที่เนื้อเรื่อง/สังคมเพิ่มเติม | 30 GB |
| โลกหลัก แผนที่เพิ่ม และ Deep Desert | 40 GB |
| แผนที่เปิดตลอดจำนวนมากหรือกิจกรรมสูง | 60 GB+ |

</details>

สำหรับโฮสต์สาธารณะ ให้ส่งต่อพอร์ตเหล่านี้:

| พอร์ต | โปรโตคอล | การใช้งาน |
|---|---|---|
| `8088` | TCP | เว็บผู้ดูแล เฉพาะผู้ดูแลที่เชื่อถือได้ |
| `31982` | TCP | จุดรับส่งข้อความเกม RabbitMQ |
| `31983` | TCP | จุด HTTP เกม RabbitMQ |
| `7777-7810` | UDP | การสื่อสารเกม |
| `32000-32015` | UDP | วัดความหน่วงตรงแบบเลือกได้ หากปิดยังใช้รีเลย์ได้ |
| `8797` | TCP | HTTPS API แบบเลือกได้ ดู[การเข้าถึง API เข้ารหัส](../console/encrypted-api.md) |

เก็บพอร์ตฐานข้อมูลและการจัดการภายในไว้เป็นส่วนตัว อย่าเปิดเว็บให้ผู้ใช้ที่ไม่เชื่อถือ

## การติดตั้ง

ใช้บัญชีปกติที่มี `sudo` แทนการล็อกอินเป็น `root` ระบบขอสิทธิ์ผู้ดูแลเมื่อจำเป็นเท่านั้น รันบน Linux ใหม่:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

ตัวติดตั้งดาวน์โหลดรุ่นล่าสุด เปิดเว็บ และแสดงที่อยู่ จากนั้นตั้งค่าต่อในเบราว์เซอร์ พาธเริ่มต้นคือ `~/dune-awakening-selfhost-docker` หากใช้ดิสก์อื่นให้ระบุพาธเต็ม:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

บน Windows ให้ใช้เทอร์มินัล Linux VM ที่รองรับหรือ Ubuntu WSL2 ไม่ใช่ PowerShell, Command Prompt หรือ shell ภายใน Docker Desktop ระบบตรวจสิทธิ์เขียนและพื้นที่ก่อนแตกไฟล์ การดาวน์โหลดล้มเหลวจะไม่เขียนทับการติดตั้งเพียงบางส่วน

Alpine Linux ใช้แพ็กเกจ Docker และ Docker Compose ของดิสโทร พร้อม OpenRC หากไม่มีคลัง community ระบบจะถามก่อนแก้การตั้งค่าคลัง

## รายชื่อเซิร์ฟเวอร์สาธารณะ

[DuneDocker.app](https://dunedocker.app/) ช่วยแนะนำชุมชนและค้นหาเซิร์ฟเวอร์ หน้าสดแสดงสถานะ จำนวนผู้เล่น ภูมิภาค Sietch ความหน่วงเฉพาะผู้ชม และลิงก์ Discord ที่เลือกเพิ่มได้

ยืนยันความเป็นเจ้าของจากการตั้งค่า Console เพื่อจัดการโปรไฟล์ คำเชิญ Discord และโปรโมตเซิร์ฟเวอร์ เปิดหรือปิดการแสดงได้ตลอด

การวัดตรงใช้ UDP `32000-32015` โปรดอนุญาตในไฟร์วอลล์โฮสต์ ไฟร์วอลล์อินเทอร์เน็ต–DMZ และ NAT หากไม่เปิดยังรองรับและใช้รีเลย์ Dune Docker อัตโนมัติ

เซิร์ฟเวอร์เฉพาะเครื่องหรือ LAN จะไม่ถูกแสดง ค่าเริ่มต้นส่งเพียงจำนวนเซิร์ฟเวอร์แบบไม่ระบุตัวตน ไม่มีชื่อ ที่อยู่ ผู้เล่น หรือการตั้งค่า และปิดแยกได้ในหน้าตั้งค่า

## เครื่องมือออกแบบฐาน

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) ใช้วางแผนและแบ่งปันฐาน 3D ในเบราว์เซอร์ ทดลองก่อนเสียเวลาและวัสดุในเกมด้วยแค็ตตาล็อกที่ค้นหาได้ เครื่องมือวาง ยึดจุด หมุน การชน และพื้นที่ครอบครอง

เปลี่ยนมุมมองและกลางวัน/กลางคืน เดินชม ถ่ายภาพ นำเข้าผังและส่งออกแบบ สมาชิกที่เข้าสู่ระบบบันทึกงาน เลือกสาธารณะ/ไม่แสดงในรายการ/ส่วนตัว เผยแพร่ตัวอย่าง สำรวจและคัดลอกแบบชุมชนได้ มีลิงก์ที่ท้าย Console ด้วย

## ส่วนเสริมชุมชน

ติดตั้งและจัดการเครื่องมือเสริมจากเว็บ โดยแจ้งสิทธิ์ก่อนติดตั้ง การอัปเดตเก็บการตั้งค่าและต้องอนุมัติสิทธิ์ใหม่ นักพัฒนาเริ่มได้จาก[แม่แบบส่วนเสริมทางการ](https://github.com/Red-Blink/dune-docker-addon-template)

## ความช่วยเหลือและเอกสาร

- [เว็บไซต์ทางการ](https://dunedocker.app/) — โครงการ ติดตั้ง คำถามและรายชื่อเซิร์ฟเวอร์
- [ออกแบบฐาน](https://blueprints.dunedocker.app/) — วางแผน ดู บันทึก และแชร์ 3D
- [เอกสารทางการ](https://docs.dunedocker.app/) — คู่มือ คุณสมบัติ เทคนิคและ API
- [ชุมชน Discord](https://discord.gg/duneawakeningdocker) — ช่วยเหลือ อัปเดต ส่วนเสริมและพูดคุย
- [เอกสารในคลัง](../README.md) — ข้อมูลเทคนิคที่ดูแลพร้อมโค้ด
- [สนับสนุนโครงการ](https://ko-fi.com/redblink) — พัฒนา ทดสอบและโครงสร้างพื้นฐาน

## ร่วมพัฒนา

ยินดีรับนักพัฒนา เจ้าของเซิร์ฟเวอร์และผู้เล่น โปรดตรวจ [Issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) และ [Pull Requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) ก่อนเพื่อไม่ทำงานซ้ำ

- **แจ้งข้อผิดพลาด:** ระบุรุ่น ขั้นตอนทำซ้ำ ผลที่คาดหวัง และลบ รหัสผ่าน/ข้อมูลส่วนตัวจากบันทึกและภาพ
- **เสนอปรับปรุง:** อธิบายปัญหาและประโยชน์ต่อชุมชน การเปลี่ยนแปลงใหญ่ควรคุยใน issue ก่อน
- **ส่ง Pull Request:** จำกัดขอบเขต เชื่อม issue และอธิบายสิ่งที่แก้กับวิธีทดสอบ
- **ช่วยนอกเหนือโค้ด:** ปรับเอกสาร ทดสอบ สร้างส่วนเสริม หรือเสนอแก้คำแปลผ่าน Console

สอบถามและเสนอไอเดียได้ใน[ชุมชน Discord](https://discord.gg/duneawakeningdocker)

## เครดิตและสัญญาอนุญาต

RedBlink เป็นผู้นำและดูแลโครงการร่วมกับชุมชน โปรดระบุ RedBlink เป็นผู้พัฒนาต้นฉบับเมื่อแบ่งปันหรือแจกจ่ายต่อ

**ฟรีและโอเพนซอร์สภายใต้ [MIT](../../LICENSE)**
