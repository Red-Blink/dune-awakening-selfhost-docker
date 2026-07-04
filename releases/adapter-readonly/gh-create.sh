#!/usr/bin/env bash
set -euo pipefail
gh pr create --repo Red-Blink/dune-awakening-selfhost-docker --base main --head yacketrj:dune-awakening-selfhost-docker-WSL:release/discord-adapter-readonly \
  --title "Add modular read-only Discord adapter integration" \
  --body-file releases/adapter-readonly/pr-body.md
