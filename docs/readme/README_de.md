<div align="center" dir="ltr">

[English](../../README.md) · **Deutsch** · [Français](README_fr.md) · [Español](README_es.md) · [Русский](README_ru.md) · [简体中文](README_zh.md) · [العربية](README_ar.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending-daily.svg" alt="Dune Awakening Community — Daily Top Repository" width="260" height="88">
  <img src="../../assets/community-trending-weekly.svg" alt="Dune Awakening Community — Weekly Top Repository" width="260" height="88">
  <img src="../../assets/community-trending-monthly.svg" alt="Dune Awakening Community — Monthly Top Repository" width="260" height="88">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console ist eine Docker-basierte Verwaltung für dedizierte Dune: Awakening-Server unter Linux, Windows/WSL2 und in virtuellen Maschinen. Geführte Installation und eine Browseroberfläche helfen dir, Spieler, Karten, Backups, Updates und den Serverbetrieb zu verwalten, ohne ständig im Terminal arbeiten zu müssen.

Dieses inoffizielle Community-Projekt ist weder mit Funcom verbunden noch wird es von Funcom empfohlen, gesponsert oder unterstützt.

Das Projekt ist experimentell. Funcom kann das Verhalten selbst gehosteter Server jederzeit ändern.

## Was Du Damit Machen Kannst

- **Einrichten & Betreiben:** Geführte Einrichtung im Browser, Updates, Dienststeuerung, geplante Neustarts, Neustartwarteschlangen, Diagnose und Wiederherstellung.
- **Alles Live Im Blick:** Interaktive Weltkarten, Spieler- und Fahrzeugpositionen, Ressourcen, Serverzustand, Leistung und Logs.
- **Arrakis Gestalten:** Karten, Sietches, Deep-Desert-Layouts, automatische Skalierung, Speicher und Spieleinstellungen anpassen sowie **experimentelle Regis Tanks** aktivieren.
- **Spieler Verwalten:** Werkzeuge für Spieler und Gilden, Inventare, Fortschritt, Basen, Lager, Fahrzeuge, Landsraad, Belohnungen und Versorgungspakete.
- **Wirtschaft Steuern:** Exchange-Angebote durchsuchen und den Handel mit dem integrierten Market Bot automatisieren.
- **Server Absichern:** Datenbank- und verschlüsselte Systembackups, Wiederherstellung und Migration, Zugriffsrollen, eingeschränkte API-Schlüssel und verschlüsselter API-Zugriff.
- **Bauen & Teilen:** Basen in 3D entwerfen, Baupläne importieren und teilen sowie den Server mit öffentlichem Profil und Latenztests präsentieren.
- **Individuell Anpassen:** Community-Addons, Discord-Integration, mehrere Oberflächensprachen und Übersetzungskorrekturen aus der Community.

Mehr zeigt die [Screenshot-Galerie](../screenshots.md).

## Voraussetzungen

Du musst kein Linux-Experte sein. Das Installationsprogramm prüft die Grundlagen und richtet Docker auf unterstützten Linux-Systemen ein.

| Voraussetzung | Empfehlung |
|---|---|
| Server | Ein frisch eingerichteter 64-Bit-Ubuntu-Server ist die einfachste und empfohlene Option. Andere Linux-Distributionen, Docker Desktop unter Windows/WSL2 und virtuelle Maschinen werden ebenfalls unterstützt. |
| Docker | Wird vom Installationsprogramm auf unterstützten Linux-Systemen eingerichtet, falls es noch fehlt. |
| CPU | AVX/AVX2-Unterstützung |
| Arbeitsspeicher | Ab 20 GB RAM; für zusätzliche dauerhaft laufende Karten 30–40 GB oder mehr |
| Speicherplatz | Mindestens 200 GB |
| Funcom-Token | Wird bei der Einrichtung sicher im Browser eingegeben |

Auf SELinux-Systemen wie Fedora und Bazzite verwendet die Console-Konfiguration eine gemeinsame Projekt-Mount-Kennzeichnung und deaktiviert die SELinux-Label-Isolierung ausschließlich für die Console, die auf den Docker-Socket des Hosts zugreifen muss. SELinux auf dem Host bleibt aktiv; Kennzeichnungen und Berechtigungen des Docker-Sockets bleiben unverändert. Führe nach dem Upgrade einer bestehenden Installation `dune console reload` aus, um diese Einstellungen anzuwenden. Unterstützt das automatische Docker-Installationsprogramm deine Distribution nicht, muss Docker bereits installiert sein.

<details>
<summary>Hinweise Zu Arbeitsspeicher Und CPU</summary>

Der Arbeitsspeicher bestimmt, wie viele Dune-Kartenserver gleichzeitig gut laufen. Beginne bei Unsicherheit mit der Grundkonfiguration und ergänze RAM für zusätzliche dauerhaft aktive Karten oder höhere Spieleraktivität.

Der offizielle Survival-Server belegt häufig etwa 10–12 GB Arbeitsspeicher, auch ohne angemeldete Spieler. Eine einzelne Messung im Leerlauf beweist daher noch kein Speicherleck. In `docker stats` entspricht `100%` CPU-Auslastung einem vollständig ausgelasteten logischen CPU-Kern.

| Serveraufbau | Empfohlener RAM |
|---|---:|
| Grundkonfiguration für den Einstieg | 20 GB |
| Hauptwelt und zusätzliche Story-/Sozialkarten | 30 GB |
| Hauptwelt, zusätzliche Karten und Deep Desert | 40 GB |
| Viele dauerhaft aktive Karten oder hohe Spieleraktivität | 60 GB+ |

</details>

Für öffentliches Hosting im Internet diese Ports weiterleiten:

| Port | Protokoll | Zweck |
|---|---|---|
| `8088` | TCP | Webverwaltung; nur vertrauenswürdigen Administratoren Zugriff geben |
| `31982` | TCP | RabbitMQ Game Messaging Endpoint |
| `31983` | TCP | RabbitMQ Game HTTP Endpoint |
| `7777-7810` | UDP | Spielverkehr |
| `32000-32015` | UDP | Optionale direkte Latenzmessungen für das öffentliche Verzeichnis; ohne Freigabe bleibt der Relay-Dienst verfügbar |
| `8797` | TCP | Optionaler verschlüsselter API-Zugriff über HTTPS; siehe [Verschlüsselter API-Zugriff](../console/encrypted-api.md) |

Datenbank- und interne Verwaltungsports privat halten. Die Weboberfläche darf nicht für nicht vertrauenswürdige Nutzer erreichbar sein.

## Installation

Starte das Installationsprogramm mit einem normalen Benutzerkonto mit `sudo`-Berechtigung, nicht als `root`. Administratorrechte werden nur bei Bedarf angefordert.

Führe auf einem frisch eingerichteten Linux-Server diesen Befehl aus:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

Das Installationsprogramm lädt die neueste Veröffentlichung herunter, startet die Weboberfläche und zeigt die aufzurufende Adresse an. Schließe die Einrichtung im Browser ab.

Standardpfad ist `~/dune-awakening-selfhost-docker`. Für ein anderes Linux-Laufwerk gib den vollständigen Zielpfad an:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Unter Windows gehört der Befehl in die unterstützte Linux-VM oder das Ubuntu-WSL2-Terminal, nicht in PowerShell, die Eingabeaufforderung oder die interne Docker-Desktop-Shell. Das Startskript prüft Schreibrechte und freien Speicher vor dem Entpacken. Fehlgeschlagene Downloads hinterlassen keine teilweise überschriebene Installation.

Unter Alpine Linux werden die Docker- und Docker-Compose-Pakete der Distribution verwendet und Docker über OpenRC gestartet. Ist das Community-Paketrepository nicht verfügbar, fragt das Installationsprogramm vor Änderungen an der Repository-Konfiguration nach.

## Öffentliches Serververzeichnis

[DuneDocker.app](https://dunedocker.app/) hilft Serverbetreibern, ihre Community vorzustellen, und Spielern, einen passenden Server zu finden. Jeder Eintrag bietet eine Live-Serverseite mit Status, Spielerzahl, Region, Sietches, persönlicher Latenz und optionalem Discord-Link.

Betreiber können ihren Eintrag direkt in den Console-Einstellungen beanspruchen, ihre Inhaberschaft bestätigen, Profil und Discord-Einladung verwalten und ihren Server präsentieren. Öffentliche Einträge lassen sich jederzeit aktivieren oder deaktivieren.

Für die schnellste direkte Latenzmessung wird UDP `32000-32015` verwendet. Erlaube den Bereich sowohl in der Host-Firewall als auch in vorgeschalteten Internet-/DMZ-Firewalls und NAT-Weiterleitungen. Ohne diese Freigabe nutzt der Server automatisch den Dune-Docker-Relay-Dienst.

Lokale und reine LAN-Server werden niemals veröffentlicht. Standardmäßig tragen Installationen nur zu einer anonymen Serverzählung bei, ohne Servernamen, Adressen, Spieler oder Einstellungen zu übertragen. Dies lässt sich separat in den Einstellungen deaktivieren.

## Base Builder

Der [Dune Docker Base Builder](https://blueprints.dunedocker.app/) ist ein browserbasiertes 3D-Werkzeug zum Planen und Teilen von Basen in Dune: Awakening. Teste Entwürfe vor dem Bauen im Spiel. Ein durchsuchbarer Katalog von Gebäudeteilen und Objekten unterstützt Platzierung, Einrasten, Drehen, Kollisionen und Gebietsabdeckung.

Betrachte Entwürfe aus verschiedenen Winkeln, wechsle zwischen Tag und Nacht, begehe das fertige Layout und erstelle Screenshots. Bestehende Layouts lassen sich zur Planung importieren und fertige Entwürfe zur weiteren Verwendung exportieren.

Angemeldete Community-Mitglieder können Projekte speichern, öffentliche, nicht gelistete oder private Sichtbarkeit wählen, Vorschauen veröffentlichen, Community-Entwürfe erkunden und veröffentlichte Baupläne als Ausgangspunkt kopieren. Der Base Builder ist auch direkt über die Fußzeile der Console erreichbar.

## Community-Addons

Community-Addons ergänzen optionale Werkzeuge, die über die Weboberfläche installiert und verwaltet werden. Ihre Berechtigungen werden vor der Installation angezeigt. Updates behalten Einstellungen bei und erfordern die Zustimmung zu neuen Berechtigungen.

Entwickler können mit der [offiziellen Addon-Vorlage](https://github.com/Red-Blink/dune-docker-addon-template) beginnen.

## Hilfe Und Dokumentation

- [Offizielle Website](https://dunedocker.app/) — Projektinformationen, Installation, FAQ und Serververzeichnis
- [Base Builder](https://blueprints.dunedocker.app/) — Basen in 3D planen, ansehen, speichern und teilen
- [Offizielle Dokumentation](https://docs.dunedocker.app/) — Anleitungen, Funktionen, technische Referenzen und API-Dokumentation
- [Discord-Community](https://discord.gg/duneawakeningdocker) — Hilfe, Updates, Addons und Austausch
- [Repository-Dokumentation](../README.md) — Technische Hinweise und Referenzen zum Quellcode
- [Projekt Unterstützen](https://ko-fi.com/redblink) — Entwicklung, Tests und Infrastruktur unterstützen

## Mitmachen

Entwickler, Serverbetreiber und Spieler sind willkommen. Prüfe vorhandene [Issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) und [Pull Requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls), bevor du beginnst, um doppelte Arbeit zu vermeiden.

- **Fehler Melden:** Gib die Projektversion, Schritte zur Reproduktion und das erwartete Verhalten an. Entferne Passwörter und personenbezogene Daten aus Logs und Screenshots.
- **Verbesserungen Vorschlagen:** Beschreibe das Problem und den Nutzen deiner Idee. Besprich größere Änderungen zuerst in einem Issue.
- **Pull Requests Einreichen:** Halte Änderungen übersichtlich, verlinke relevante Issues und erkläre Umsetzung und Tests.
- **Auch Ohne Code Helfen:** Verbessere die Dokumentation, teste Änderungen, entwickle Addons oder schlage Übersetzungskorrekturen direkt in der Console vor.

Für Fragen und Ideen besuche die [Discord-Community](https://discord.gg/duneawakeningdocker).

## Urheber Und Lizenz

Dune Docker Console wird von RedBlink gemeinsam mit der Community entwickelt und gepflegt. Nenne RedBlink als ursprünglichen Entwickler, wenn du das Projekt weitergibst oder verbreitest.

**Kostenlos und quelloffen unter der [MIT-Lizenz](../../LICENSE).**
