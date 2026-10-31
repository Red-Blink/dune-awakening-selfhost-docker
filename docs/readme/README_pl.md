<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · **Polski** · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console to oparty na Dockerze menedżer serwerów dedykowanych Dune: Awakening dla Linux, Windows/WSL2 i maszyn wirtualnych. Instalacja z przewodnikiem i panel w przeglądarce pozwalają zarządzać graczami, mapami, kopiami zapasowymi, aktualizacjami i pracą serwera.

To nieoficjalny projekt społeczności, niepowiązany z Funcom, bez jego aprobaty, sponsoringu ani wsparcia. Projekt jest eksperymentalny; działanie samodzielnego hostingu Funcom może się zmieniać.

## Co Możesz Zrobić

- **Wdrażaj i Obsługuj:** Konfiguracja w przeglądarce, aktualizacje, sterowanie usługami, harmonogramy i kolejka restartów, diagnostyka i odzyskiwanie.
- **Obserwuj na Żywo:** Interaktywne mapy, śledzenie graczy i pojazdów, zasoby, stan serwera, wydajność i logi.
- **Zarządzaj Arrakis:** Mapy, sicze, układy Deep Desert, automatyczne skalowanie, pamięć, ustawienia gry i **eksperymentalne Regis Tanks**.
- **Zarządzaj Graczami:** Narzędzia graczy i gildii, ekwipunek, postępy, bazy, magazyny, pojazdy, Landsraad, nagrody i Care Packages.
- **Prowadź Gospodarkę:** Przeglądaj oferty Exchange i automatyzuj handel wbudowanym Market Bot.
- **Chroń Serwer:** Kopie bazy i szyfrowane kopie systemu, przywracanie, migracja, role, klucze API z ograniczonymi uprawnieniami i szyfrowany dostęp API.
- **Buduj i Udostępniaj:** Projektowanie baz 3D, import i udostępnianie planów, publiczny profil serwera i pomiary opóźnień.
- **Dostosuj:** Dodatki społeczności, integracja Discord, wiele języków i społecznościowe poprawki tłumaczeń.

Przejmij stery i odkryj swoje centrum dowodzenia! [Wypróbuj konsolę](https://try.dunedocker.app/) z przykładowymi danymi — bez instalacji.

## Wymagania

Nie musisz znać się na Linux. Instalator sprawdza podstawy i przygotowuje Docker w obsługiwanych systemach Linux.

| Element | Zalecenie |
|---|---|
| Serwer | Najprościej: świeży 64-bitowy Ubuntu. Obsługiwane są też inne Linux, Docker Desktop na Windows/WSL2 i maszyny wirtualne. |
| Docker | Instalator przygotuje go na obsługiwanym Linux, jeśli go nie ma. |
| CPU | AVX/AVX2 |
| Pamięć | Na początek 20 GB RAM; 30–40 GB lub więcej na dodatkowe stale aktywne mapy |
| Dysk | 200 GB lub więcej |
| Token Funcom | Bezpiecznie wprowadzany podczas konfiguracji w przeglądarce |

<details>
<summary>Pamięć i Procesor</summary>

RAM ogranicza liczbę map. Zacznij od układu podstawowego, zwiększając pamięć dla stale aktywnych map i większego ruchu. Oficjalny Survival często zajmuje około 10–12 GB pamięci rezydentnej nawet bez graczy; pojedynczy pomiar bezczynności nie dowodzi wycieku. W `docker stats` wartość `100%` oznacza pełne użycie jednego logicznego CPU.

| Układ | Zalecana RAM |
|---|---:|
| Podstawowy serwer | 20 GB |
| Główny świat i mapy fabularne/społecznościowe | 30 GB |
| Główny świat, dodatkowe mapy i Deep Desert | 40 GB |
| Wiele stale aktywnych map lub duży ruch | 60 GB+ |

</details>

Dla publicznego hostingu przekieruj porty:

| Port | Protokół | Cel |
|---|---|---|
| `8088` | TCP | Panel WWW tylko dla zaufanych administratorów |
| `31982` | TCP | Komunikacja wiadomości gry RabbitMQ |
| `31983` | TCP | Punkt HTTP gry RabbitMQ |
| `7777-7810` | UDP | Ruch gry |
| `32000-32015` | UDP | Opcjonalne bezpośrednie pomiary opóźnień; przy zamkniętych portach działa przekaźnik |
| `8797` | TCP | Opcjonalne HTTPS API; [Szyfrowany Dostęp API](../console/encrypted-api.md) |

Porty bazy i wewnętrznego zarządzania zachowaj prywatne. Nie udostępniaj panelu niezaufanym użytkownikom.

## Instalacja

Użyj zwykłego konta z `sudo`, zamiast logować się jako `root`. Instalator prosi o uprawnienia tylko w razie potrzeby. Na świeżym Linux uruchom:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

Pobierze najnowsze wydanie, uruchomi panel i poda adres. Dokończ w przeglądarce. Domyślna ścieżka: `~/dune-awakening-selfhost-docker`. Dla innego dysku podaj pełną ścieżkę:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Na Windows użyj terminala obsługiwanej maszyny Linux lub Ubuntu WSL2, nie PowerShell, wiersza poleceń ani wewnętrznej powłoki Docker Desktop. Przed rozpakowaniem sprawdzane są zapis i miejsce; nieudane pobranie nie nadpisuje częściowo instalacji.

Alpine Linux używa pakietów Docker/Docker Compose dystrybucji i OpenRC. Gdy repozytorium community jest niedostępne, instalator pyta przed zmianą konfiguracji.

## Publiczny Katalog Serwerów

[DuneDocker.app](https://dunedocker.app/) promuje społeczności i pomaga znaleźć serwer. Strona pokazuje bieżący stan, liczbę graczy, region, sicze, indywidualne opóźnienie i opcjonalny Discord.

W Ustawieniach Console potwierdź własność wpisu, zarządzaj profilem i zaproszeniem Discord oraz promuj serwer. Publikację można przełączać w każdej chwili.

Bezpośredni pomiar używa UDP `32000-32015`; zezwól na zakres na hoście, zaporze internet–DMZ i w NAT. W przeciwnym razie serwer automatycznie używa przekaźnika Dune Docker, zachowując zgodność.

Serwery lokalne i wyłącznie LAN nigdy nie są publikowane. Domyślnie przekazywana jest jedynie anonimowa liczba serwerów, bez nazw, adresów, graczy czy ustawień. Można ją osobno wyłączyć w Ustawieniach.

## Projektant Baz

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) umożliwia planowanie i dzielenie się bazami 3D w przeglądarce. Wypróbuj układy przed zużyciem czasu i materiałów w grze: przeszukiwalny katalog, umieszczanie, przyciąganie, obrót, kolizje i zasięg terytorium.

Zmieniaj widok i dzień/noc, spaceruj, rób zrzuty, importuj układy i eksportuj projekty. Po zalogowaniu zapisuj, wybieraj widoczność publiczną/niepubliczną/prywatną, publikuj podglądy, odkrywaj i kopiuj plany społeczności. Link znajduje się też w stopce Console.

## Dodatki Społeczności

Instaluj i zarządzaj opcjonalnymi narzędziami z panelu. Uprawnienia są deklarowane przed instalacją; aktualizacje zachowują ustawienia, a nowe uprawnienia wymagają zgody. Deweloperzy mogą użyć [Oficjalnego Szablonu](https://github.com/Red-Blink/dune-docker-addon-template).

## Pomoc i Dokumentacja

- [Oficjalna Strona](https://dunedocker.app/) — Projekt, instalacja, FAQ i katalog
- [Projektant Baz](https://blueprints.dunedocker.app/) — Planowanie, podgląd, zapis i udostępnianie 3D
- [Oficjalna Dokumentacja](https://docs.dunedocker.app/) — Przewodniki, funkcje, technika i API
- [Discord](https://discord.gg/duneawakeningdocker) — Pomoc, aktualizacje, dodatki i rozmowy
- [Dokumentacja Repozytorium](../README.md) — Notatki techniczne utrzymywane z kodem
- [Wesprzyj Projekt](https://ko-fi.com/redblink) — Rozwój, testy i infrastruktura

## Współpraca

Zapraszamy deweloperów, właścicieli serwerów i graczy. Sprawdź istniejące [zgłoszenia](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) i [pull requesty](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls), aby uniknąć powielania pracy.

- **Zgłoś Błąd:** Wersja, kroki, oczekiwany wynik; usuń hasła i dane osobowe z logów i zdjęć.
- **Zaproponuj Ulepszenie:** Opisz problem i korzyść; większe zmiany omów najpierw w zgłoszeniu.
- **Wyślij Pull Request:** Skup zmiany, podaj powiązane zgłoszenia, opisz działanie i testy.
- **Pomóż Bez Kodu:** Dokumentacja, testy, dodatki lub poprawki tłumaczeń w Console.

Pytania i pomysły omawiamy na [Discordzie](https://discord.gg/duneawakeningdocker).

## Autorzy i Licencja

RedBlink prowadzi i utrzymuje projekt przy wsparciu społeczności. Przy udostępnianiu i redystrybucji podaj RedBlink jako oryginalnego twórcę.

**Bezpłatne, otwarte oprogramowanie na [Licencji MIT](../../LICENSE).**
