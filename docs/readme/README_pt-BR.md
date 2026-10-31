<div align="center" dir="ltr">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · **Português (Brasil)** · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md)

</div>

# Dune: Awakening Docker - Self-Hosted Server Console

<p align="center">
  <img src="../../assets/community-trending.svg" alt="Dune Awakening Community — #1 Repository Of The Day, Week, and Month" width="840" height="79">
</p>

![Dune Awakening Self-Host Docker cover](../../assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console é um gerenciador de servidores dedicados de Dune: Awakening baseado em Docker para Linux, Windows/WSL2 e máquinas virtuais. A instalação guiada e o painel no navegador permitem gerenciar jogadores, mapas, backups, atualizações e operações do servidor.

Este projeto comunitário não é oficial nem possui vínculo, aprovação, patrocínio ou suporte da Funcom. É experimental; o comportamento da hospedagem própria da Funcom pode mudar.

## O Que Você Pode Fazer

- **Implantar e Operar:** Configuração guiada no navegador, atualizações, controle de serviços, agendamento e fila de reinicializações, diagnóstico e recuperação.
- **Acompanhar ao Vivo:** Mapas interativos, rastreamento de jogadores e veículos, recursos, integridade, desempenho e logs.
- **Controlar Arrakis:** Mapas, Sietches, layouts do Deep Desert, escalonamento automático, memória, configurações de jogo e **Regis Tanks experimentais**.
- **Gerenciar Jogadores:** Ferramentas de jogadores e guildas, inventários, progresso, bases, depósitos, veículos, Landsraad, recompensas e Care Packages.
- **Movimentar a Economia:** Consulte ofertas do Exchange e automatize negociações com o Market Bot integrado.
- **Proteger o Servidor:** Backups do banco e backups criptografados do sistema, restauração, migração, funções de acesso, chaves API com permissões limitadas e API criptografada.
- **Construir e Compartilhar:** Projete bases em 3D, importe e compartilhe plantas, divulgue o servidor com perfil público e testes de latência.
- **Personalizar:** Addons comunitários, integração Discord, vários idiomas e correções de tradução da comunidade.

Veja a [Galeria de Capturas](../screenshots.md).

## Requisitos

Não é preciso ser especialista em Linux. O instalador verifica o básico e prepara Docker nos sistemas Linux compatíveis.

| Item | Recomendação |
|---|---|
| Servidor | Ubuntu 64 bits recém-instalado é a opção mais simples. Também há suporte a outros Linux, Docker Desktop no Windows/WSL2 e máquinas virtuais. |
| Docker | O instalador prepara Docker no Linux compatível caso ainda não esteja disponível. |
| CPU | Suporte AVX/AVX2 |
| Memória | Comece com 20 GB RAM; 30–40 GB ou mais para mapas adicionais sempre ativos |
| Armazenamento | 200 GB ou mais |
| Token Funcom | Informado com segurança na configuração pelo navegador |

Em hosts SELinux, como Fedora e Bazzite, usa-se um rótulo compartilhado nas montagens do projeto. O confinamento por rótulo é desativado apenas para a Console, que precisa acessar o socket Docker do host. SELinux do host, rótulos e permissões do socket permanecem iguais. Após atualizar, execute `dune console reload`. Instale Docker previamente se o instalador automático dele não aceitar sua distribuição.

<details>
<summary>Orientações de Memória e CPU</summary>

A RAM determina quantos mapas rodam confortavelmente. Comece pelo layout básico e aumente conforme os mapas permanentes e a atividade. O Survival oficial costuma manter cerca de 10–12 GB residentes mesmo sem jogadores; uma medição ociosa isolada não prova vazamento. No `docker stats`, `100%` representa um processador lógico totalmente ocupado.

| Layout | RAM Recomendada |
|---|---:|
| Servidor básico | 20 GB |
| Mundo principal e mapas de história/sociais | 30 GB |
| Mundo principal, mapas extras e Deep Desert | 40 GB |
| Muitos mapas permanentes ou alta atividade | 60 GB+ |

</details>

Para hospedagem pública na internet, encaminhe:

| Porta | Protocolo | Finalidade |
|---|---|---|
| `8088` | TCP | Administração web, apenas administradores confiáveis |
| `31982` | TCP | Endpoint de mensagens do jogo RabbitMQ |
| `31983` | TCP | Endpoint HTTP do jogo RabbitMQ |
| `7777-7810` | UDP | Tráfego do jogo |
| `32000-32015` | UDP | Medição direta opcional de latência; há relay com portas fechadas |
| `8797` | TCP | API HTTPS opcional; [Acesso API Criptografado](../console/encrypted-api.md) |

Mantenha privadas as portas de banco e administração interna. Não exponha o painel a usuários não confiáveis.

## Instalação

Use uma conta comum com `sudo`, sem fazer login como `root`. O instalador pede privilégios apenas quando necessário. Em um Linux novo, execute:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | sh
```

O instalador baixa a última versão publicada, inicia o painel e mostra o endereço. Conclua no navegador. O caminho padrão é `~/dune-awakening-selfhost-docker`; para outro disco, informe o destino completo:

```sh
curl -fsSL https://raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/bootstrap.sh | DUNE_INSTALL_DIR=/mnt/dune/dune-awakening-selfhost-docker sh
```

No Windows, use o terminal de uma VM Linux compatível ou Ubuntu WSL2, nunca PowerShell, Prompt de Comando ou shell interno do Docker Desktop. A gravação e o espaço são verificados antes da extração; downloads com falha não deixam a instalação parcialmente sobrescrita.

Alpine Linux usa os pacotes Docker/Docker Compose da distribuição e OpenRC. Se o repositório community estiver indisponível, o instalador pede permissão antes de mudar sua configuração.

## Diretório Público de Servidores

[DuneDocker.app](https://dunedocker.app/) divulga comunidades e ajuda jogadores a encontrar servidores. Cada página ao vivo tem status, jogadores, região, Sietches, latência individual e Discord opcional.

Nas Configurações da Console, reivindique a listagem para verificar a propriedade, gerenciar perfil e convite Discord e promover seu servidor. A publicação pode ser ativada ou desativada a qualquer momento.

A medição direta usa UDP `32000-32015`; libere no firewall do host, entre internet e DMZ e no NAT. Sem esse acesso, o servidor continua compatível e usa automaticamente o relay Dune Docker.

Servidores locais ou exclusivos de LAN nunca são listados. Por padrão, apenas uma contagem anônima é compartilhada, sem nomes, endereços, jogadores ou configurações. Ela pode ser desativada separadamente nas Configurações.

## Construtor de Bases

[Dune Docker Base Builder](https://blueprints.dunedocker.app/) é uma ferramenta 3D de planejamento e compartilhamento no navegador. Teste antes de gastar tempo e materiais no jogo, com catálogo pesquisável, posicionamento, encaixe, rotação, colisão e cobertura de território.

Mude ângulos e dia/noite, caminhe pelo projeto, tire capturas, importe layouts e exporte designs. Após entrar, salve, escolha visibilidade pública/não listada/privada, publique prévias, explore e copie plantas comunitárias. Há um link no rodapé da Console.

## Addons Comunitários

Instale e gerencie ferramentas opcionais pelo painel. Permissões são declaradas antes da instalação; atualizações preservam configurações e exigem aprovação para permissões novas. Desenvolvedores podem usar o [Modelo Oficial](https://github.com/Red-Blink/dune-docker-addon-template).

## Ajuda e Documentação

- [Site Oficial](https://dunedocker.app/) — Projeto, instalação, FAQ e diretório
- [Construtor de Bases](https://blueprints.dunedocker.app/) — Planejar, visualizar, salvar e compartilhar em 3D
- [Documentação Oficial](https://docs.dunedocker.app/) — Guias, recursos, referências técnicas e API
- [Discord](https://discord.gg/duneawakeningdocker) — Suporte, novidades, addons e conversa
- [Documentação do Repositório](../README.md) — Notas técnicas mantidas com o código
- [Apoie o Projeto](https://ko-fi.com/redblink) — Desenvolvimento, testes e infraestrutura

## Como Contribuir

Desenvolvedores, administradores e jogadores são bem-vindos. Confira [issues](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues) e [pull requests](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pulls) para evitar trabalho duplicado.

- **Relate Bugs:** Informe versão, passos e resultado esperado; remova senhas e dados pessoais de logs e capturas.
- **Sugira Melhorias:** Explique o problema e o benefício; discuta mudanças grandes em uma issue antes.
- **Envie Pull Requests:** Mantenha o foco, vincule issues e descreva mudanças e testes.
- **Ajude Além do Código:** Documentação, testes, addons ou sugestões de correção de tradução na Console.

Dúvidas e ideias podem ser discutidas no [Discord](https://discord.gg/duneawakeningdocker).

## Créditos e Licença

RedBlink lidera e mantém o projeto com contribuições da comunidade. Ao compartilhar ou redistribuir, credite RedBlink como desenvolvedor original.

**Gratuito e de código aberto sob a [Licença MIT](../../LICENSE).**
