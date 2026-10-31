<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · **Italiano** · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending-daily.svg" alt="Dune Awakening Community — Daily Top Repository" width="280" height="79">
  <img src="../../assets/community-trending-weekly.svg" alt="Dune Awakening Community — Weekly Top Repository" width="280" height="79">
  <img src="../../assets/community-trending-monthly.svg" alt="Dune Awakening Community — Monthly Top Repository" width="280" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console è un gestore di server dedicati Dune: Awakening basato su Docker per Linux, Windows/WSL2 e macchine virtuali. Installazione guidata e pannello nel browser permettono di gestire giocatori, mappe, backup, aggiornamenti e operazioni del server.

È un progetto comunitario non ufficiale, senza affiliazione, approvazione, sponsorizzazione o supporto di Funcom. Il progetto è sperimentale; il comportamento dell’hosting autonomo Funcom può cambiare.

## Cosa Puoi Fare

- **Installa e Gestisci:** Configurazione nel browser, aggiornamenti, controllo servizi, riavvii programmati e in coda, diagnosi e ripristino.
- **Segui in Diretta:** Mappe interattive, giocatori e veicoli, risorse, stato del server, prestazioni e log.
- **Controlla Arrakis:** Mappe, Sietch, configurazioni Deep Desert, ridimensionamento automatico, memoria, impostazioni di gioco e **Regis Tanks sperimentali**.
- **Gestisci i Giocatori:** Strumenti per giocatori e gilde, inventari, progressi, basi, depositi, veicoli, Landsraad, ricompense e Care Packages.
- **Gestisci l’Economia:** Consulta gli annunci Exchange e automatizza il commercio con il Market Bot integrato.
- **Proteggi il Server:** Backup del database e backup di sistema cifrati, ripristino, migrazione, ruoli, chiavi API con permessi limitati e accesso API cifrato.
- **Costruisci e Condividi:** Progetti di basi 3D, importazione e condivisione di planimetrie, profilo pubblico e test di latenza.
- **Personalizza:** Addon comunitari, Discord, diverse lingue e correzioni delle traduzioni dalla comunità.

Consulta la [Galleria di Schermate](../screenshots.md).

## Requisiti

Non serve essere esperti di Linux. Il programma d’installazione verifica i requisiti e prepara Docker sui sistemi Linux supportati.

| Elemento | Raccomandazione |
|---|---|
| Server | Ubuntu a 64 bit appena installato è la scelta più semplice. Supportati anche altri Linux, Docker Desktop su Windows/WSL2 e macchine virtuali. |
| Docker | Preparato dall’installatore sui Linux supportati se assente. |
| CPU | Supporto AVX/AVX2 |
| Memoria | Inizia con 20 GB RAM; 30–40 GB o più per mappe aggiuntive sempre attive |
| Archiviazione | 200 GB o più |
| Token Funcom | Inserito in sicurezza durante la configurazione nel browser |

Su SELinux, come Fedora e Bazzite, viene usata un’etichetta condivisa per i montaggi del progetto. Il confinamento tramite etichette è disabilitato solo per Console, che richiede il socket Docker dell’host. SELinux dell’host, etichette e permessi del socket restano invariati. Dopo l’aggiornamento esegui `dune console reload`. Installa prima Docker se il suo installatore automatico non supporta la distribuzione.

<details>
<summary>Indicazioni su RAM e CPU</summary>

La RAM determina quante mappe funzionano agevolmente. Parti dalla configurazione base e aumentala per mappe permanenti e più attività. Il Survival ufficiale mantiene spesso circa 10–12 GB residenti anche senza giocatori; una singola lettura a riposo non dimostra una perdita di memoria. In `docker stats`, `100%` significa un processore logico interamente utilizzato.

| Configurazione | RAM Consigliata |
|---|---:|
| Server base | 20 GB |
| Mondo principale e mappe narrative/sociali | 30 GB |
| Mondo principale, mappe aggiuntive e Deep Desert | 40 GB |
| Molte mappe permanenti o attività elevata | 60 GB+ |

</details>

Per l’hosting pubblico su internet inoltra queste porte:

| Porta | Protocollo | Scopo |
|---|---|---|
| `8088` | TCP | Pannello web, solo amministratori fidati |
| `31982` | TCP | Endpoint messaggi di gioco RabbitMQ |
| `31983` | TCP | Endpoint HTTP di gioco RabbitMQ |
| `7777-7810` | UDP | Traffico di gioco |
| `32000-32015` | UDP | Misura diretta opzionale della latenza; relay disponibile con porte chiuse |
| `8797` | TCP | API HTTPS opzionale; [Accesso API Cifrato](../console/encrypted-api.md) |

Mantieni private le porte del database e dell’amministrazione interna. Non esporre il pannello a utenti non fidati.

## Installazione

Usa un account normale con `sudo`, senza accedere come `root`. I privilegi vengono richiesti solo quando necessari. Su un nuovo Linux esegui:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

L’installatore scarica l’ultima release, avvia il pannello e mostra l’indirizzo. Completa nel browser. Il percorso predefinito è `~/dune-awakening-selfhost-docker`; per un altro disco specifica la destinazione completa:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Su Windows usa il terminale della VM Linux supportata o Ubuntu WSL2, non PowerShell, Prompt dei comandi o shell interna di Docker Desktop. Scrittura e spazio vengono controllati prima dell’estrazione; un download fallito non sovrascrive parzialmente l’installazione.

Alpine Linux usa i pacchetti Docker/Docker Compose della distribuzione e OpenRC. Se il repository community non è disponibile, l’installatore chiede prima di cambiarne la configurazione.

## Elenco Pubblico dei Server

[DuneDocker.app](https://dunedocker.app/) presenta le comunità e aiuta a trovare server. Le pagine mostrano stato, giocatori, regione, Sietch, latenza personale e Discord opzionale.

Rivendica la scheda dalle Impostazioni Console per verificare la proprietà, gestire profilo e invito Discord e promuovere il server. Puoi attivare o disattivare la pubblicazione in qualsiasi momento.

La misura diretta usa UDP `32000-32015`: consenti l’intervallo nel firewall host, tra internet e DMZ e nel NAT. Altrimenti il server resta compatibile e usa automaticamente il relay Dune Docker.

I server locali o solo LAN non sono mai elencati. Per impostazione predefinita viene condiviso solo un conteggio anonimo, senza nomi, indirizzi, giocatori o impostazioni. Si può disattivare separatamente nelle Impostazioni.

## Progettazione delle Basi

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) permette di pianificare e condividere basi 3D nel browser. Prova prima di spendere tempo e materiali nel gioco: catalogo ricercabile, posizionamento, aggancio, rotazione, collisioni e copertura del territorio.

Cambia vista e giorno/notte, cammina nel progetto, scatta immagini, importa disposizioni ed esporta progetti. Dopo l’accesso puoi salvare, scegliere visibilità pubblica/non elencata/privata, pubblicare anteprime, esplorare e copiare planimetrie comunitarie. Il collegamento è anche nel piè di pagina Console.

## Addon Comunitari

Installa e gestisci strumenti opzionali nel pannello. I permessi sono dichiarati prima dell’installazione; gli aggiornamenti conservano le impostazioni e richiedono approvazione per nuovi permessi. Gli sviluppatori possono partire dal [Modello Ufficiale](https://github.com/Red-Blink/dune-docker-addon-template).

## Aiuto e Documentazione

- [Sito Ufficiale](https://dunedocker.app/) — Progetto, installazione, FAQ ed elenco server
- [Progettazione Basi](https://blueprints.dunedocker.app/) — Pianifica, visualizza, salva e condividi in 3D
- [Documentazione Ufficiale](https://docs.dunedocker.app/) — Guide, funzioni, riferimenti tecnici e API
- [Discord](https://discord.gg/duneawakeningdocker) — Supporto, aggiornamenti, addon e discussioni
- [Documentazione del Repository](../README.md) — Note tecniche mantenute con il codice
- [Sostieni il Progetto](https://ko-fi.com/redblink) — Sviluppo, test e infrastruttura

## Come Contribuire

Sviluppatori, proprietari e giocatori sono benvenuti. Controlla [issue](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) e [pull request](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) per evitare duplicazioni.

- **Segnala Bug:** Versione, passaggi e risultato atteso; rimuovi password e dati personali da log e immagini.
- **Proponi Migliorie:** Descrivi problema e beneficio; discuti prima i cambiamenti grandi in un’issue.
- **Invia Pull Request:** Mantieni le modifiche mirate, collega le issue, spiega cambiamenti e test.
- **Aiuta Oltre il Codice:** Documentazione, prove, addon o correzioni delle traduzioni dalla Console.

Domande e idee sono benvenute su [Discord](https://discord.gg/duneawakeningdocker).

## Crediti e Licenza

RedBlink guida e mantiene il progetto con la comunità. Quando condividi o ridistribuisci, indica RedBlink come sviluppatore originale.

**Gratuito e open source con [Licenza MIT](../../LICENSE).**
