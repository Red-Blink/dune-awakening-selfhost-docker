# Dune: Awakening Docker - Self-Hosted Server Console

![Dune Awakening Self-Host Docker cover](assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console is a Docker-based Dune: Awakening dedicated server manager for Linux, Windows/WSL2, and virtual machines. It provides guided installation and a browser admin panel for managing players, maps, backups, updates, and server operations without living in the terminal.

This is an unofficial community project and is not affiliated with, endorsed by, sponsored by, or supported by Funcom.

The project is experimental, and Funcom self-hosting behavior may change over time.

## What You Can Do

- Set up and manage the server from your browser
- Monitor status, logs, readiness, backups, and updates
- Manage players, inventories, progression, rewards, vehicles, and admin actions
- Control maps, Sietches, Deep Desert layouts, and live map activity
- Configure memory, autoscaling, and game settings
- Manage databases, bases, storage, and player blueprints
- Plan, preview, and share base layouts in 3D with the Base Builder
- Extend the console with optional Community Addons

See the [Screenshots Gallery](docs/screenshots.md) for a closer look.

## Requirements

You do not need to be a Linux expert. The installer checks the basics and prepares Docker on supported Linux systems.

| What&nbsp;You&nbsp;Need | Recommendation |
|---|---|
| Server | A fresh 64-bit Ubuntu server is the recommended and easiest option. Other Linux distributions, Docker Desktop on Windows/WSL2, and virtual machines are also supported. |
| Docker | The installer prepares Docker on supported Linux systems if it is not already available. |
| CPU | AVX/AVX2 support |
| Memory | Start with 20 GB RAM; use 30–40 GB or more for additional always-on maps |
| Storage | 200 GB or more |
| Funcom token | Entered securely during browser setup |

On SELinux hosts such as Fedora and Bazzite, the Console configuration includes
a shared project mount label and disables SELinux label confinement only for the
Console, which needs access to the host Docker socket. Host SELinux remains enabled;
the Docker socket's labels and permissions are unchanged. After upgrading an existing
installation, run `dune console reload` to apply these settings to the Console.
Docker must already be installed if its automatic installer does not support your
distribution.

<details>
<summary>Memory & CPU Guidance</summary>

RAM determines how many Dune map servers can run comfortably. Start with the basic layout if you are unsure and add more RAM for additional always-on maps or heavier player activity.

The official Survival server commonly keeps roughly 10–12 GB resident even with no players online; a single idle snapshot is not by itself a memory leak. In `docker stats`, CPU is measured in CPU-core units: `100%` means one fully used logical CPU.

| Server Layout | Recommended RAM |
|---|---:|
| Basic server for getting started | 20 GB |
| Main world plus extra story/social maps | 30 GB |
| Main world, extra maps, and Deep Desert | 40 GB |
| Many always-on maps or heavier player activity | 60 GB+ |

</details>

For public/internet hosting, forward these ports:

| Port | Protocol | Purpose |
|---|---|---|
| `8088` | TCP | Web admin panel; allow access only for trusted administrators |
| `31982` | TCP | RabbitMQ Game Messaging Endpoint |
| `31983` | TCP | RabbitMQ Game HTTP Endpoint |
| `7777-7810` | UDP | Game Traffic |
| `32000-32015` | UDP | Optional direct public-directory latency probes; relay remains available when closed |
| `8797` | TCP | Optional encrypted API access (HTTPS); see [Encrypted API access](docs/console/encrypted-api.md) |

Keep database and internal admin ports private. Do not expose the Web UI to untrusted users.

## Installation

Run the installer from a regular user account with `sudo` access, not while logged in as `root`. The installer requests administrator access only when required.

Copy and paste this command on a fresh Linux server:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

The installer downloads the latest release, starts the Web UI, and tells you which address to open. Complete the remaining setup in your browser.

The default installation path is `~/dune-awakening-selfhost-docker`. To use a different Linux disk, set the complete destination explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

On Windows, run the command in the supported Linux VM or Ubuntu WSL2 terminal—not PowerShell, Command Prompt, or Docker Desktop's internal shell. The bootstrap checks that the destination is writable and has space before it extracts anything; failed downloads never leave a partially overwritten installation.

On Alpine Linux, the installer uses the distribution's Docker and Docker Compose packages and starts Docker through OpenRC. If the community repository is unavailable, the installer asks before changing repository configuration.

## Public Server Directory

[DuneDocker.app](https://dunedocker.app/) helps public server owners showcase their communities and helps players find the right server. Each listing provides a live server page with status, player count, region, Sietches, personalized latency, and an optional Discord community link.

Owners can claim their listing directly from the Console Settings page to verify ownership, manage their public profile and Discord invite, and promote their server through the directory. Public listings can be enabled or disabled at any time.

Personalized latency uses UDP `32000-32015` for the fastest direct measurement. Allow this range through both the host firewall and any internet-to-DMZ firewall or NAT forwarding. Servers that do not expose the range remain compatible and automatically use the Dune Docker relay instead.

Local and LAN-only servers are never listed. For transparency, installations contribute only an anonymous server count by default—never server names, addresses, players, or settings—and this can be disabled separately in Settings.

## Base Builder

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) is a browser-based 3D planning and sharing tool for Dune: Awakening bases. It lets you experiment with layouts before committing time and materials in-game, using a searchable catalog of structures and placeables with placement, snapping, rotation, collision, and claim-coverage tools.

Preview designs from different angles, switch between day and night, walk through the finished layout, and capture screenshots. Existing layouts can be imported for planning, while completed designs can be exported for future use.

Signed-in community members can save projects, choose public, unlisted, or private visibility, publish previews, explore shared community designs, and fork a published blueprint as a starting point. The Base Builder is also linked directly from the Console footer.

## Community Addons

Community Addons provide optional tools that can be installed and managed from the Web UI. Addons declare their permissions before installation, and updates preserve their settings and require approval for any new permissions.

Developers can start with the [Official Addon Template](https://github.com/Red-Blink/dune-docker-addon-template).

## Help and Documentation

- [Official Website](https://dunedocker.app/) — Project information, installation guidance, FAQ, and server directory
- [Base Builder](https://blueprints.dunedocker.app/) — Plan, preview, save, and share Dune: Awakening base layouts in 3D
- [Official Documentation](https://docs.dunedocker.app/) — Guides, feature documentation, technical references, and API documentation
- [Discord Community](https://discord.gg/duneawakeningdocker) — Support, updates, addons, and community discussion
- [Repository Documentation](docs/README.md) — Technical notes and references maintained alongside the source code
- [Support the Project](https://ko-fi.com/redblink) — Help support development, testing, and infrastructure

## Contributing

Issues, fixes, and improvements are welcome. Keep secrets, generated runtime files, and backups out of Git, and never expose the Web UI to untrusted users.

Translation corrections can be submitted from the Console's language globe: select **Suggest a Translation Fix**, find the incorrect phrase, edit it, and submit. A credit name is optional; contributors need no GitHub account. Suggestions do not immediately change the interface or other installations. Existing Console authentication and the separate `community:suggest-translation` permission protect submissions; API keys cannot submit corrections.

Founders review suggestions at `https://dunedocker.app/translations.html` using the existing website Discord login. Accepting or editing a correction adds it to the approved queue. **Prepare Translation Update** freezes approved corrections into a batch. The repository's **Prepare Community Translation Updates** workflow creates an ordinary PR every 15 minutes or on manual dispatch, then requests the normal CI checks. A maintainer reviews, merges, and includes the changes in a normal project release. No suggestions are automatically merged, released, or installed.

Reviewed corrections are stored in `console/api/data/i18n-reviewed/<LANG>.json`, using the original English phrase as the key. They take precedence over generated translations and older runtime caches. `credits.json` preserves optional contributor credit. Machine translation maintenance only fills the generated catalog and never overwrites these reviewed files. CI validates phrase keys, languages, placeholders and safe text. Run `node console/api/scripts/export-translation-catalog.mjs` after updating interface phrases; commit the public catalog along with the reviewed source changes.

Maintainers must publish the website review service and this workflow, and enable GitHub's **Allow GitHub Actions to create and approve pull requests** repository setting before activating PR preparation. The workflow itself never approves or merges a PR. Website deployment/authentication details and isolated integration-test instructions are in the directory-service repository. The Console language picker has no provider-key or peer-network setup requirement.

## Credits and License

Dune Docker Console is led and maintained by RedBlink with contributions from the community. Please credit RedBlink as the original developer when sharing or redistributing the project.

**Free and open source under the [MIT License](LICENSE).**
