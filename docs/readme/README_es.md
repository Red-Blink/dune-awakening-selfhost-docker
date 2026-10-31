<div align="center" dir="ltr">

[English](../../README.md) · [Deutsch](README_de.md) · [Français](README_fr.md) · **Español** · [Русский](README_ru.md) · [简体中文](README_zh.md) · [العربية](README_ar.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending-daily.svg" alt="Dune Awakening Community — Daily Top Repository" width="260" height="88">
  <img src="../../assets/community-trending-weekly.svg" alt="Dune Awakening Community — Weekly Top Repository" width="260" height="88">
  <img src="../../assets/community-trending-monthly.svg" alt="Dune Awakening Community — Monthly Top Repository" width="260" height="88">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console es un administrador de servidores dedicados de Dune: Awakening basado en Docker para Linux, Windows/WSL2 y máquinas virtuales. Ofrece instalación guiada y un panel web para gestionar jugadores, mapas, copias de seguridad, actualizaciones y operaciones del servidor sin depender del terminal.

Este proyecto comunitario no es oficial ni está afiliado, avalado, patrocinado o respaldado por Funcom.

El proyecto es experimental y el funcionamiento del alojamiento propio de Funcom puede cambiar con el tiempo.

## Qué Puedes Hacer

- **Instalar y Administrar:** Configuración guiada desde el navegador, actualizaciones, control de servicios, reinicios programados, colas de reinicio, diagnóstico y recuperación.
- **Ver Todo en Directo:** Mapas interactivos, seguimiento de jugadores y vehículos, ubicaciones de recursos, estado del servidor, rendimiento y registros.
- **Controlar Arrakis:** Configura mapas, Sietches, distribuciones del Deep Desert, escalado automático, memoria, ajustes de juego y **Regis Tanks experimentales**.
- **Gestionar Jugadores:** Herramientas para jugadores y gremios, inventarios, progreso, bases, almacenamiento, vehículos, Landsraad, recompensas y Care Packages.
- **Gestionar la Economía:** Consulta las ofertas del Exchange y automatiza el comercio con el Market Bot integrado.
- **Proteger Tu Servidor:** Copias de la base de datos y copias cifradas del sistema, restauración, migración, roles de acceso, claves API con permisos limitados y acceso API cifrado.
- **Construir y Compartir:** Diseña bases en 3D, importa y comparte planos, y presenta tu servidor con un perfil público y pruebas de latencia.
- **Personalizar Tu Experiencia:** Complementos comunitarios, integración con Discord, varios idiomas y correcciones de traducción aportadas por la comunidad.

Consulta la [Galería de Capturas](../screenshots.md) para verlo con más detalle.

## Requisitos

No necesitas ser experto en Linux. El instalador comprueba los requisitos básicos y prepara Docker en sistemas Linux compatibles.

| Requisito | Recomendación |
|---|---|
| Servidor | Se recomienda un servidor Ubuntu de 64 bits recién instalado: es la opción más sencilla. También se admiten otras distribuciones Linux, Docker Desktop en Windows/WSL2 y máquinas virtuales. |
| Docker | El instalador prepara Docker en sistemas Linux compatibles si todavía no está disponible. |
| CPU | Compatibilidad con AVX/AVX2 |
| Memoria | Empieza con 20 GB de RAM; utiliza 30–40 GB o más para mapas adicionales siempre activos |
| Almacenamiento | 200 GB o más |
| Token de Funcom | Se introduce de forma segura durante la configuración en el navegador |

En equipos con SELinux, como Fedora y Bazzite, la configuración incluye una etiqueta compartida para los montajes del proyecto y desactiva el confinamiento por etiquetas únicamente para la Console, que necesita acceder al socket Docker del equipo. SELinux sigue activo en el equipo; las etiquetas y los permisos del socket Docker no cambian. Después de actualizar una instalación existente, ejecuta `dune console reload` para aplicar estos ajustes a la Console. Docker debe estar instalado previamente si su instalador automático no admite tu distribución.

<details>
<summary>Orientación Sobre Memoria y CPU</summary>

La RAM determina cuántos servidores de mapas pueden funcionar con comodidad. Si tienes dudas, empieza con la distribución básica y añade RAM para más mapas siempre activos o una mayor actividad de jugadores.

El servidor oficial Survival suele mantener aproximadamente 10–12 GB de memoria residente incluso sin jugadores; una sola medición en reposo no demuestra una fuga de memoria. En `docker stats`, la CPU se mide en unidades de núcleo: `100%` significa un procesador lógico totalmente ocupado.

| Distribución del Servidor | RAM Recomendada |
|---|---:|
| Servidor básico para empezar | 20 GB |
| Mundo principal y mapas adicionales de historia/sociales | 30 GB |
| Mundo principal, mapas adicionales y Deep Desert | 40 GB |
| Muchos mapas siempre activos o mayor actividad de jugadores | 60 GB+ |

</details>

Para alojar un servidor público en internet, redirige estos puertos:

| Puerto | Protocolo | Uso |
|---|---|---|
| `8088` | TCP | Panel web de administración; permite acceso solo a administradores de confianza |
| `31982` | TCP | Punto de conexión de mensajería del juego RabbitMQ |
| `31983` | TCP | Punto de conexión HTTP del juego RabbitMQ |
| `7777-7810` | UDP | Tráfico del juego |
| `32000-32015` | UDP | Pruebas directas de latencia opcionales del directorio público; el relé sigue disponible si están cerrados |
| `8797` | TCP | Acceso API cifrado opcional (HTTPS); consulta [Acceso API Cifrado](../console/encrypted-api.md) |

Mantén privados los puertos de la base de datos y de administración interna. No expongas la interfaz web a usuarios que no sean de confianza.

## Instalación

Ejecuta el instalador desde una cuenta normal con acceso a `sudo`, sin iniciar sesión como `root`. El instalador solicita permisos de administrador únicamente cuando son necesarios.

Copia y pega este comando en un servidor Linux recién instalado:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

El instalador descarga la última versión publicada, inicia la interfaz web e indica qué dirección abrir. Completa el resto de la configuración en tu navegador.

La ruta predeterminada es `~/dune-awakening-selfhost-docker`. Para usar otro disco en Linux, especifica el destino completo:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

En Windows, ejecuta el comando en una máquina virtual Linux compatible o en el terminal de Ubuntu WSL2, no en PowerShell, el símbolo del sistema ni la consola interna de Docker Desktop. El instalador comprueba que el destino permita escritura y tenga espacio antes de extraer archivos; las descargas fallidas no dejan una instalación parcialmente sobrescrita.

En Alpine Linux, el instalador utiliza los paquetes Docker y Docker Compose de la distribución e inicia Docker mediante OpenRC. Si el repositorio community no está disponible, pide permiso antes de cambiar su configuración.

## Directorio Público de Servidores

[DuneDocker.app](https://dunedocker.app/) permite a los propietarios presentar sus comunidades y ayuda a los jugadores a encontrar un servidor adecuado. Cada entrada ofrece una página con estado en directo, número de jugadores, región, Sietches, latencia personalizada y un enlace opcional a Discord.

Los propietarios pueden reclamar su entrada desde los Ajustes de la Console para verificar la propiedad, gestionar el perfil público y la invitación de Discord, y promocionar su servidor. La publicación puede activarse o desactivarse en cualquier momento.

La latencia personalizada utiliza UDP `32000-32015` para la medición directa más rápida. Permite este rango tanto en el cortafuegos del equipo como en cualquier cortafuegos de internet a la DMZ o redirección NAT. Los servidores que no lo exponen siguen siendo compatibles y utilizan automáticamente el relé de Dune Docker.

Los servidores locales o exclusivos de LAN nunca se publican. Por transparencia, las instalaciones solo contribuyen por defecto a un recuento anónimo de servidores, sin nombres, direcciones, jugadores ni ajustes. Esta opción puede desactivarse por separado en Ajustes.

## Constructor de Bases

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) es una herramienta web para planificar y compartir bases de Dune: Awakening en 3D. Permite probar diseños antes de invertir tiempo y materiales en el juego, con un catálogo de estructuras y objetos con búsqueda y herramientas de colocación, encaje, rotación, colisiones y cobertura del territorio.

Previsualiza diseños desde distintos ángulos, alterna entre día y noche, recorre el diseño terminado y toma capturas. Puedes importar diseños existentes para planificar y exportar los terminados para usarlos después.

Los miembros registrados pueden guardar proyectos, elegir visibilidad pública, no listada o privada, publicar vistas previas, explorar diseños comunitarios y crear una copia de un plano publicado como punto de partida. También hay un enlace al constructor en el pie de la Console.

## Complementos Comunitarios

Los complementos comunitarios ofrecen herramientas opcionales que se instalan y gestionan desde la interfaz web. Declaran sus permisos antes de instalarse; las actualizaciones conservan sus ajustes y requieren aprobación para cualquier permiso nuevo.

Los desarrolladores pueden empezar con la [Plantilla Oficial de Complementos](https://github.com/Red-Blink/dune-docker-addon-template).

## Ayuda y Documentación

- [Sitio Oficial](https://dunedocker.app/) — Información del proyecto, instalación, preguntas frecuentes y directorio de servidores
- [Constructor de Bases](https://blueprints.dunedocker.app/) — Planifica, previsualiza, guarda y comparte bases en 3D
- [Documentación Oficial](https://docs.dunedocker.app/) — Guías, funciones, referencias técnicas y documentación API
- [Comunidad en Discord](https://discord.gg/duneawakeningdocker) — Ayuda, novedades, complementos y conversaciones
- [Documentación del Repositorio](../README.md) — Notas técnicas y referencias mantenidas junto al código
- [Apoya el Proyecto](https://ko-fi.com/redblink) — Ayuda al desarrollo, las pruebas y la infraestructura

## Cómo Contribuir

Dune Docker recibe aportaciones de desarrolladores, propietarios de servidores y jugadores. Revisa las [incidencias](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) y [solicitudes de cambios](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) existentes para evitar duplicar trabajo.

- **Informa de Errores:** Incluye la versión, los pasos para reproducirlos y el resultado esperado. Añade registros o capturas relevantes sin contraseñas ni datos personales.
- **Propón Mejoras:** Explica qué problema resolvería tu idea y cómo ayudaría a la comunidad. Comenta los cambios grandes en una incidencia antes de implementarlos.
- **Envía Solicitudes de Cambios:** Mantén los cambios centrados, enlaza las incidencias relacionadas y explica qué cambiaste y cómo lo probaste.
- **Ayuda Más Allá del Código:** Mejora la documentación, prueba cambios, crea complementos o sugiere correcciones de traducción desde la Console.

Para preguntar o comentar una idea, únete a la [Comunidad en Discord](https://discord.gg/duneawakeningdocker).

## Créditos y Licencia

RedBlink dirige y mantiene Dune Docker Console con aportaciones de la comunidad. Menciona a RedBlink como desarrollador original al compartir o redistribuir el proyecto.

**Gratuito y de código abierto bajo la [Licencia MIT](../../LICENSE).**
