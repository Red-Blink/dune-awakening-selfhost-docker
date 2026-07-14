#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
exec runtime/scripts/metrics-stack.sh status
