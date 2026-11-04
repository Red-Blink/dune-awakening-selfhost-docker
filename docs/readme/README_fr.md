<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · **Français** · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console est un gestionnaire de serveurs dédiés Dune: Awakening basé sur Docker, pour Linux, Windows/WSL2 et les machines virtuelles. Il propose une installation guidée et une interface d’administration dans le navigateur pour gérer joueurs, cartes, sauvegardes, mises à jour et opérations sans passer son temps dans le terminal.

Ce projet communautaire non officiel n’est ni affilié à Funcom, ni approuvé, parrainé ou pris en charge par Funcom.

Le projet est expérimental. Le fonctionnement de l’auto-hébergement Funcom peut évoluer.

## Ce Que Vous Pouvez Faire

- **Déployer Et Exploiter :** Installation guidée dans le navigateur, mises à jour, gestion des services, redémarrages programmés ou en file d’attente, diagnostic et récupération.
- **Tout Voir En Direct :** Cartes interactives, positions des joueurs et véhicules, ressources, état du serveur, performances et journaux.
- **Façonner Arrakis :** Configurer cartes, sietchs, dispositions du Deep Desert, adaptation automatique des ressources, mémoire, paramètres de jeu et **Regis Tanks expérimentaux**.
- **Gérer Les Joueurs :** Outils pour joueurs et guildes, inventaires, progression, bases, stockage, véhicules, Landsraad, récompenses et colis de ravitaillement.
- **Piloter L’Économie :** Consulter les annonces Exchange et automatiser les échanges avec le Market Bot intégré.
- **Protéger Le Serveur :** Sauvegardes de base de données et sauvegardes système chiffrées, restauration, migration, rôles, clés API à permissions limitées et accès API chiffré.
- **Construire Et Partager :** Concevoir des bases en 3D, importer et partager des plans, présenter son serveur avec un profil public et des mesures de latence.
- **Personnaliser :** Addons communautaires, intégration Discord, plusieurs langues d’interface et corrections de traduction proposées par la communauté.

Prenez les commandes et explorez votre centre de contrôle ! [Essayez la console](https://try.dunedocker.app/) avec des données d’exemple, sans installation.

## Prérequis

Pas besoin d’être spécialiste de Linux. L’installateur effectue les vérifications essentielles et prépare Docker sur les systèmes Linux compatibles.

| Élément | Recommandation |
|---|---|
| Serveur | Un serveur Ubuntu 64 bits fraîchement installé est recommandé et constitue l’option la plus simple. D’autres distributions Linux, Docker Desktop sous Windows/WSL2 et les machines virtuelles sont aussi pris en charge. |
| Docker | L’installateur le prépare sur les systèmes Linux compatibles s’il n’est pas déjà disponible. |
| Processeur | Prise en charge AVX/AVX2 |
| Mémoire | À partir de 20 Go de RAM ; 30–40 Go ou davantage pour des cartes supplémentaires toujours actives |
| Stockage | Au moins 200 Go |
| Jeton Funcom | Saisi de manière sécurisée lors de la configuration dans le navigateur |

<details>
<summary>Conseils Sur La Mémoire Et Le Processeur</summary>

La RAM détermine le nombre de serveurs de cartes Dune pouvant fonctionner confortablement. Commencez avec une configuration simple et ajoutez de la mémoire pour les cartes permanentes ou une activité plus importante.

Le serveur Survival officiel conserve couramment environ 10–12 Go en mémoire, même sans joueurs connectés. Une mesure isolée au repos ne suffit donc pas à démontrer une fuite mémoire. Dans `docker stats`, `100%` de CPU correspond à un cœur logique entièrement utilisé.

| Configuration | RAM recommandée |
|---|---:|
| Serveur de base pour démarrer | 20 Go |
| Monde principal et cartes narratives/sociales supplémentaires | 30 Go |
| Monde principal, cartes supplémentaires et Deep Desert | 40 Go |
| Nombreuses cartes permanentes ou activité importante | 60 Go+ |

</details>

Pour un hébergement public sur Internet, redirigez les ports suivants :

| Port | Protocole | Usage |
|---|---|---|
| `8088` | TCP | Administration web ; accès réservé aux administrateurs de confiance |
| `31982` | TCP | Point de terminaison RabbitMQ Game Messaging |
| `31983` | TCP | Point de terminaison RabbitMQ Game HTTP |
| `7777-7810` | UDP | Trafic du jeu |
| `32000-32015` | UDP | Mesures directes de latence facultatives pour l’annuaire public ; le relais reste disponible si ces ports sont fermés |
| `8797` | TCP | Accès API chiffré facultatif en HTTPS ; voir [Accès API chiffré](../console/encrypted-api.md) |

Gardez les ports de base de données et d’administration interne privés. Ne rendez pas l’interface web accessible à des utilisateurs non fiables.

## Installation

Lancez l’installateur depuis un compte utilisateur normal disposant de `sudo`, et non depuis une session `root`. Les droits administrateur ne sont demandés que si nécessaire.

Sur un nouveau serveur Linux, copiez et exécutez :

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

L’installateur télécharge la dernière version publiée, démarre l’interface web et indique l’adresse à ouvrir. Terminez la configuration dans votre navigateur.

Le dossier par défaut est `~/dune-awakening-selfhost-docker`. Pour utiliser un autre disque Linux, précisez le chemin complet :

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Sous Windows, utilisez le terminal de la VM Linux compatible ou d’Ubuntu WSL2, et non PowerShell, l’invite de commandes ou le shell interne de Docker Desktop. Le script vérifie les droits d’écriture et l’espace disponible avant l’extraction. Un téléchargement échoué ne laisse pas une installation partiellement écrasée.

Sous Alpine Linux, l’installateur utilise les paquets Docker et Docker Compose de la distribution et démarre Docker avec OpenRC. Si le dépôt communautaire est indisponible, il demande confirmation avant de modifier la configuration des dépôts.

## Annuaire Public Des Serveurs

[DuneDocker.app](https://dunedocker.app/) permet aux propriétaires de présenter leur communauté et aux joueurs de trouver un serveur adapté. Chaque fiche dispose d’une page en direct avec état, nombre de joueurs, région, sietchs, latence personnalisée et lien Discord facultatif.

Les propriétaires peuvent revendiquer leur fiche depuis les paramètres de la Console pour vérifier leur propriété, gérer leur profil et leur invitation Discord, puis faire connaître leur serveur. La publication peut être activée ou désactivée à tout moment.

La mesure directe la plus rapide utilise UDP `32000-32015`. Autorisez cette plage dans le pare-feu de l’hôte ainsi que dans les pare-feu Internet/DMZ et les redirections NAT en amont. Sans cette ouverture, le serveur reste compatible et utilise automatiquement le relais Dune Docker.

Les serveurs locaux ou limités au réseau local ne sont jamais publiés. Par défaut, les installations contribuent uniquement à un comptage anonyme des serveurs, sans noms, adresses, joueurs ni paramètres. Cette participation peut être désactivée séparément dans les paramètres.

## Base Builder

Le [Dune Docker Base Builder](https://blueprints.dunedocker.app/) est un outil web de conception et de partage de bases en 3D pour Dune: Awakening. Essayez des agencements avant d’y consacrer du temps et des matériaux en jeu, avec un catalogue de structures et d’objets consultable et des outils de placement, d’accrochage, de rotation, de collision et de couverture du territoire.

Examinez les créations sous différents angles, passez du jour à la nuit, parcourez la base et prenez des captures. Importez un agencement existant pour le planifier ou exportez une création terminée pour la réutiliser.

Les membres connectés peuvent enregistrer leurs projets, choisir une visibilité publique, non répertoriée ou privée, publier des aperçus, découvrir les créations de la communauté et dupliquer un plan publié comme point de départ. Le Base Builder est aussi accessible depuis le pied de page de la Console.

## Addons Communautaires

Les addons ajoutent des outils facultatifs installables et gérables depuis l’interface web. Leurs permissions sont présentées avant installation. Les mises à jour conservent les paramètres et nécessitent une approbation pour toute nouvelle permission.

Les développeurs peuvent utiliser le [modèle officiel d’addon](https://github.com/Red-Blink/dune-docker-addon-template).

## Aide Et Documentation

- [Site officiel](https://dunedocker.app/) — Présentation, installation, FAQ et annuaire
- [Base Builder](https://blueprints.dunedocker.app/) — Concevoir, prévisualiser, enregistrer et partager des bases en 3D
- [Documentation officielle](https://docs.dunedocker.app/) — Guides, fonctionnalités, références techniques et API
- [Communauté Discord](https://discord.gg/duneawakeningdocker) — Assistance, actualités, addons et échanges
- [Documentation du dépôt](../README.md) — Notes techniques et références maintenues avec le code
- [Soutenir le projet](https://ko-fi.com/redblink) — Contribuer au développement, aux tests et à l’infrastructure

## Contribuer

Développeurs, propriétaires de serveurs et joueurs sont les bienvenus. Consultez les [issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) et [pull requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) existantes pour éviter les doublons.

- **Signaler Un Bug :** Indiquez la version, les étapes de reproduction et le résultat attendu. Retirez mots de passe et données personnelles des journaux et captures.
- **Proposer Une Amélioration :** Expliquez le problème et le bénéfice pour la communauté. Discutez les changements importants dans une issue avant de les réaliser.
- **Soumettre Une Pull Request :** Limitez les changements à un objectif clair, liez les issues concernées et précisez les modifications et tests effectués.
- **Aider Sans Coder :** Améliorez la documentation, testez les changements, créez des addons ou proposez des corrections de traduction dans la Console.

Pour poser une question ou discuter d’une idée, rejoignez la [communauté Discord](https://discord.gg/duneawakeningdocker).

## Crédits Et Licence

Dune Docker Console est dirigé et maintenu par RedBlink avec l’aide de la communauté. Merci de citer RedBlink comme développeur d’origine lors du partage ou de la redistribution du projet.

**Gratuit et open source sous [licence MIT](../../LICENSE).**
