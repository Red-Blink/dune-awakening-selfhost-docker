<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · **한국어** · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console은 Linux, Windows/WSL2, 가상 머신을 지원하는 Docker 기반 Dune: Awakening 전용 서버 관리 도구입니다. 안내식 설치와 브라우저 관리 화면으로 플레이어, 지도, 백업, 업데이트, 서버 운영을 관리할 수 있습니다.

Funcom과 제휴하거나 승인, 후원, 지원을 받지 않는 비공식 커뮤니티 프로젝트입니다. 프로젝트는 실험 단계이며 Funcom의 자체 호스팅 동작은 달라질 수 있습니다.

## 할 수 있는 일

- **배포와 운영:** 브라우저 안내 설정, 업데이트, 서비스 제어, 예약 재시작, 재시작 대기열, 진단과 복구.
- **실시간 확인:** 대화형 세계 지도, 플레이어와 차량 추적, 자원 위치, 서버 상태, 성능과 로그.
- **아라키스 설정:** 지도, Sietch, Deep Desert 배치, 자동 확장, 메모리, 게임 설정과 **실험적 Regis Tanks**.
- **플레이어 관리:** 플레이어와 길드 도구, 인벤토리, 진행도, 기지, 저장소, 차량, Landsraad, 보상과 Care Packages.
- **경제 운영:** Exchange 매물 조회와 내장 Market Bot을 이용한 자동 거래.
- **서버 보호:** 데이터베이스 및 암호화 시스템 백업, 복원과 이전, 접근 역할, 권한 범위가 지정된 API 키와 암호화 API.
- **건설과 공유:** 3D 기지 설계, 설계도 가져오기와 공유, 공개 서버 프로필과 지연 시간 확인.
- **맞춤 설정:** 커뮤니티 애드온, Discord 연동, 여러 Console 언어와 커뮤니티 번역 수정.

[스크린샷 모음](../screenshots.md)을 확인하세요.

## 요구 사항

Linux 전문가일 필요는 없습니다. 설치 도구가 기본 요건을 확인하고 지원되는 Linux에서 Docker를 준비합니다.

| 항목 | 권장 사항 |
|---|---|
| 서버 | 새로 설치한 64비트 Ubuntu가 가장 간단합니다. 다른 Linux, Windows/WSL2의 Docker Desktop, 가상 머신도 지원합니다. |
| Docker | 지원 Linux에 Docker가 없으면 설치 도구가 준비합니다. |
| CPU | AVX/AVX2 지원 |
| 메모리 | 처음에는 20 GB RAM, 추가 상시 지도에는 30–40 GB 이상 |
| 저장 공간 | 200 GB 이상 |
| Funcom 토큰 | 브라우저 설정 중 안전하게 입력 |

Fedora, Bazzite 같은 SELinux 호스트에서는 공유 프로젝트 마운트 레이블을 사용하고, 호스트 Docker 소켓에 접근해야 하는 Console에만 레이블 격리를 해제합니다. 호스트 SELinux와 소켓 레이블·권한은 유지됩니다. 업그레이드 후 `dune console reload`를 실행하세요. 자동 Docker 설치가 배포판을 지원하지 않으면 Docker를 미리 설치해야 합니다.

<details>
<summary>메모리와 CPU 안내</summary>

RAM은 원활하게 실행할 수 있는 지도 수를 결정합니다. 기본 구성으로 시작하고 상시 지도나 플레이어 활동에 따라 늘리세요. 공식 Survival 서버는 접속자가 없어도 약 10–12 GB 상주 메모리를 사용합니다. 유휴 상태의 한 번의 측정만으로 메모리 누수라고 판단할 수 없습니다. `docker stats`에서 `100%`는 논리 CPU 하나의 전체 사용을 뜻합니다.

| 구성 | 권장 RAM |
|---|---:|
| 입문용 기본 서버 | 20 GB |
| 주 세계와 추가 스토리/소셜 지도 | 30 GB |
| 주 세계, 추가 지도, Deep Desert | 40 GB |
| 많은 상시 지도 또는 활발한 플레이어 활동 | 60 GB+ |

</details>

인터넷 공개 호스팅에는 다음 포트를 전달하세요.

| 포트 | 프로토콜 | 용도 |
|---|---|---|
| `8088` | TCP | 웹 관리 화면, 신뢰하는 관리자만 허용 |
| `31982` | TCP | RabbitMQ 게임 메시징 엔드포인트 |
| `31983` | TCP | RabbitMQ 게임 HTTP 엔드포인트 |
| `7777-7810` | UDP | 게임 통신 |
| `32000-32015` | UDP | 선택적 공개 목록 직접 지연 측정, 닫혀 있으면 중계 사용 |
| `8797` | TCP | 선택적 HTTPS API, [암호화 API 접근](../console/encrypted-api.md) 참고 |

데이터베이스와 내부 관리 포트는 비공개로 유지하고, 웹 화면을 신뢰할 수 없는 사용자에게 노출하지 마세요.

## 설치

`root` 로그인 대신 `sudo` 권한이 있는 일반 계정에서 실행하세요. 필요한 경우에만 관리자 권한을 요청합니다. 새 Linux 서버에서 실행할 명령입니다.

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

최신 릴리스를 내려받아 웹 화면을 시작하고 주소를 알려줍니다. 나머지는 브라우저에서 설정하세요. 기본 경로는 `~/dune-awakening-selfhost-docker`입니다. 다른 디스크에는 전체 경로를 지정하세요.

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

Windows에서는 지원 Linux VM 또는 Ubuntu WSL2 터미널을 사용하세요. PowerShell, 명령 프롬프트, Docker Desktop 내부 셸은 사용하지 마세요. 압축 해제 전에 쓰기 권한과 공간을 검사하며 다운로드 실패로 설치가 일부 덮어써지지 않습니다.

Alpine Linux에서는 배포판의 Docker·Docker Compose 패키지와 OpenRC를 사용합니다. community 저장소가 없으면 설정 변경 전에 동의를 구합니다.

## 공개 서버 목록

[DuneDocker.app](https://dunedocker.app/)은 커뮤니티를 소개하고 플레이어가 서버를 찾도록 돕습니다. 공개 페이지에 실시간 상태, 플레이어 수, 지역, Sietch, 개인별 지연 시간과 선택적 Discord 링크가 표시됩니다.

Console 설정에서 목록의 소유권을 인증하고 공개 프로필과 Discord 초대를 관리하며 서버를 홍보할 수 있습니다. 공개 여부는 언제든 변경할 수 있습니다.

빠른 직접 측정에는 UDP `32000-32015`를 호스트 방화벽, 인터넷과 DMZ 사이의 방화벽 및 NAT에서 허용하세요. 닫혀 있어도 자동으로 Dune Docker 중계를 사용하므로 호환됩니다.

로컬·LAN 전용 서버는 표시하지 않습니다. 기본적으로 익명 서버 수만 집계하며 이름, 주소, 플레이어, 설정은 포함하지 않습니다. 이 집계도 설정에서 따로 끌 수 있습니다.

## 기지 설계 도구

[Dune Docker Base Builder](https://blueprints.dunedocker.app/)는 브라우저 기반 3D 설계·공유 도구입니다. 게임에서 시간과 재료를 쓰기 전에 검색 가능한 건축 목록과 배치, 스냅, 회전, 충돌, 영토 범위 도구로 설계를 시험하세요.

시점·낮과 밤 변경, 둘러보기, 스크린샷, 기존 배치 가져오기와 완성본 내보내기를 지원합니다. 로그인하면 저장, 공개·목록 비공개·비공개 선택, 미리보기 게시, 커뮤니티 설계 탐색과 공개 설계도 복제가 가능합니다. Console 하단에도 링크가 있습니다.

## 커뮤니티 애드온

웹 화면에서 선택적 도구를 설치하고 관리합니다. 설치 전 권한을 알리고, 업데이트는 설정을 유지하며 새 권한에는 승인이 필요합니다. 개발자는 [공식 애드온 템플릿](https://github.com/Red-Blink/dune-docker-addon-template)을 사용할 수 있습니다.

## 도움말과 문서

- [공식 사이트](https://dunedocker.app/) — 개요, 설치, FAQ, 서버 목록
- [기지 설계 도구](https://blueprints.dunedocker.app/) — 3D 설계, 미리보기, 저장, 공유
- [공식 문서](https://docs.dunedocker.app/) — 안내, 기능, 기술 자료와 API
- [Discord 커뮤니티](https://discord.gg/duneawakeningdocker) — 지원, 소식, 애드온과 토론
- [저장소 문서](../README.md) — 소스와 함께 관리하는 기술 자료
- [프로젝트 후원](https://ko-fi.com/redblink) — 개발, 테스트와 인프라 지원

## 기여하기

개발자, 서버 운영자, 플레이어의 참여를 환영합니다. 중복을 피하도록 기존 [이슈](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues)와 [Pull Request](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls)를 먼저 확인하세요.

- **버그 보고:** 버전, 재현 절차, 예상 결과와 관련 로그·이미지를 제공하되 비밀번호와 개인정보는 제거하세요.
- **개선 제안:** 해결할 문제와 커뮤니티의 이점을 설명하고 큰 변경은 이슈에서 먼저 논의하세요.
- **Pull Request:** 범위를 좁히고 관련 이슈, 변경 내용과 테스트 방법을 설명하세요.
- **코드 외 기여:** 문서, 테스트, 애드온 또는 Console의 번역 수정 제안으로 도와주세요.

질문과 아이디어는 [Discord 커뮤니티](https://discord.gg/duneawakeningdocker)에서 나눠 주세요.

## 기여자와 라이선스

RedBlink가 개발·유지보수를 이끌고 커뮤니티가 기여합니다. 공유하거나 재배포할 때 원 개발자로 RedBlink를 명시해 주세요.

**무료 오픈 소스이며 [MIT 라이선스](../../LICENSE)를 따릅니다.**
