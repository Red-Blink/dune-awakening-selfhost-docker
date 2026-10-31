<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · **Română**

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console este un manager de servere dedicate Dune: Awakening bazat pe Docker pentru Linux, Windows/WSL2 și mașini virtuale. Instalarea ghidată și panoul din browser permit administrarea jucătorilor, hărților, copiilor de siguranță, actualizărilor și operațiunilor serverului.

Este un proiect comunitar neoficial, fără afiliere, aprobare, sponsorizare sau suport din partea Funcom. Proiectul este experimental; comportamentul găzduirii proprii Funcom se poate schimba.

## Ce Poți Face

- **Instalează și Administrează:** Configurare în browser, actualizări, control servicii, programare și coadă de reporniri, diagnostic și recuperare.
- **Urmărește în Direct:** Hărți interactive, jucători și vehicule, resurse, sănătatea serverului, performanță și jurnale.
- **Controlează Arrakis:** Hărți, Sietch-uri, configurații Deep Desert, scalare automată, memorie, setări de joc și **Regis Tanks experimentale**.
- **Gestionează Jucătorii:** Instrumente pentru jucători și bresle, inventare, progres, baze, depozite, vehicule, Landsraad, recompense și Care Packages.
- **Administrează Economia:** Consultă ofertele Exchange și automatizează comerțul cu Market Bot integrat.
- **Protejează Serverul:** Copii ale bazei de date și copii de sistem criptate, restaurare, migrare, roluri, chei API cu permisiuni limitate și API criptat.
- **Construiește și Distribuie:** Proiectează baze 3D, importă și partajează planuri, prezintă serverul prin profil public și teste de latență.
- **Personalizează:** Addonuri comunitare, Discord, mai multe limbi și corecturi de traducere din comunitate.

Vezi [Galeria de Capturi](../screenshots.md).

## Cerințe

Nu trebuie să fii expert Linux. Instalatorul verifică bazele și pregătește Docker pe sistemele Linux acceptate.

| Element | Recomandare |
|---|---|
| Server | Ubuntu nou, pe 64 de biți, este cel mai simplu. Sunt acceptate și alte Linux, Docker Desktop pe Windows/WSL2 și mașini virtuale. |
| Docker | Pregătit de instalator pe Linux acceptat dacă lipsește. |
| CPU | Suport AVX/AVX2 |
| Memorie | Începe cu 20 GB RAM; 30–40 GB sau mai mult pentru hărți suplimentare permanente |
| Stocare | 200 GB sau mai mult |
| Token Funcom | Introdus în siguranță la configurarea în browser |

<details>
<summary>Memorie și Procesor</summary>

RAM determină câte hărți rulează confortabil. Începe cu configurația de bază și mărește pentru hărți permanente și activitate. Survival oficial păstrează adesea aproximativ 10–12 GB de memorie rezidentă chiar fără jucători; o singură măsurare în repaus nu dovedește o scurgere. În `docker stats`, `100%` înseamnă un procesor logic utilizat complet.

| Configurație | RAM Recomandată |
|---|---:|
| Server de bază | 20 GB |
| Lume principală și hărți narative/sociale | 30 GB |
| Lume principală, hărți suplimentare și Deep Desert | 40 GB |
| Multe hărți permanente sau activitate intensă | 60 GB+ |

</details>

Pentru găzduire publică pe internet, redirecționează:

| Port | Protocol | Scop |
|---|---|---|
| `8088` | TCP | Administrare web, doar administratori de încredere |
| `31982` | TCP | Endpoint mesaje de joc RabbitMQ |
| `31983` | TCP | Endpoint HTTP de joc RabbitMQ |
| `7777-7810` | UDP | Trafic de joc |
| `32000-32015` | UDP | Măsurare directă opțională; releul rămâne disponibil cu porturile închise |
| `8797` | TCP | API HTTPS opțional; [Acces API Criptat](../console/encrypted-api.md) |

Păstrează private porturile bazei și administrării interne. Nu expune panoul utilizatorilor de neîncredere.

## Instalare

Folosește un cont obișnuit cu `sudo`, nu o sesiune `root`. Permisiunile administrative sunt cerute doar când trebuie. Pe Linux nou rulează:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

Instalatorul descarcă ultima versiune publicată, pornește panoul și afișează adresa. Finalizează în browser. Calea implicită este `~/dune-awakening-selfhost-docker`; pentru alt disc indică destinația completă:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Pe Windows folosește terminalul unei VM Linux acceptate sau Ubuntu WSL2, nu PowerShell, Command Prompt ori shellul intern Docker Desktop. Scrierea și spațiul sunt verificate înainte de extragere; descărcările eșuate nu suprascriu parțial instalarea.

Alpine Linux folosește pachetele Docker/Docker Compose ale distribuției și OpenRC. Dacă depozitul community lipsește, instalatorul cere acordul înainte de a modifica setările.

## Director Public de Servere

[DuneDocker.app](https://dunedocker.app/) prezintă comunități și ajută jucătorii să găsească servere. Paginile live afișează stare, număr de jucători, regiune, Sietch-uri, latență personală și Discord opțional.

Revendică înregistrarea din Setările Console pentru verificarea proprietății, gestionarea profilului și invitației Discord și promovare. Publicarea poate fi comutată oricând.

Măsurarea directă folosește UDP `32000-32015`; permite intervalul pe gazdă, în firewallul internet–DMZ și în NAT. În caz contrar, serverul rămâne compatibil și folosește automat releul Dune Docker.

Serverele locale sau exclusiv LAN nu sunt listate. Implicit se contribuie doar la un număr anonim de servere, fără nume, adrese, jucători ori setări. Acesta poate fi oprit separat din Setări.

## Constructor de Baze

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) oferă proiectare și partajare 3D în browser. Încearcă înainte de a investi timp și materiale în joc, cu un catalog căutabil, plasare, aliniere, rotire, coliziuni și acoperirea teritoriului.

Schimbă unghiurile și ziua/noaptea, plimbă-te, fă capturi, importă configurații și exportă proiecte. După autentificare poți salva, alege vizibilitate publică/nelistată/privată, publica previzualizări, explora și copia planuri comunitare. Linkul este și în subsolul Console.

## Addonuri Comunitare

Instalează și gestionează instrumente opționale în panou. Permisiunile sunt declarate înainte; actualizările păstrează setările și cer aprobarea noilor permisiuni. Dezvoltatorii pot folosi [Șablonul Oficial](https://github.com/Red-Blink/dune-docker-addon-template).

## Ajutor și Documentație

- [Site Oficial](https://dunedocker.app/) — Proiect, instalare, FAQ și director
- [Constructor de Baze](https://blueprints.dunedocker.app/) — Planificare, previzualizare, salvare și partajare 3D
- [Documentație Oficială](https://docs.dunedocker.app/) — Ghiduri, funcții, tehnică și API
- [Discord](https://discord.gg/duneawakeningdocker) — Ajutor, actualizări, addonuri și discuții
- [Documentația Depozitului](../README.md) — Note tehnice întreținute cu sursele
- [Susține Proiectul](https://ko-fi.com/redblink) — Dezvoltare, testare și infrastructură

## Contribuții

Dezvoltatorii, administratorii și jucătorii sunt bineveniți. Verifică [problemele](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) și [cererile de integrare](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) pentru a evita dublarea.

- **Raportează Erori:** Versiune, pași și rezultat așteptat; elimină parolele și datele personale din jurnale și capturi.
- **Propune Îmbunătățiri:** Explică problema și beneficiul; discută întâi schimbările mari într-o problemă.
- **Trimite Modificări:** Păstrează concentrarea, leagă problemele, descrie schimbările și testele.
- **Ajută Fără Cod:** Documentație, teste, addonuri sau corecturi de traducere în Console.

Întrebări și idei pe [Discord](https://discord.gg/duneawakeningdocker).

## Autori și Licență

RedBlink conduce și întreține proiectul cu ajutorul comunității. La partajare sau redistribuire, menționează RedBlink ca dezvoltator original.

**Gratuit și cu sursă deschisă sub [Licența MIT](../../LICENSE).**
