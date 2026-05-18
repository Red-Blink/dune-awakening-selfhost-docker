#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
LAB_DIR="$(pwd)"

cat > /usr/local/bin/dune <<EOF
#!/usr/bin/env bash
set -euo pipefail

LAB_DIR="\${DUNE_DOCKER_DIR:-$LAB_DIR}"

if [ ! -d "\$LAB_DIR" ]; then
  echo "Dune lab directory not found: \$LAB_DIR"
  echo "Set DUNE_DOCKER_DIR=/path/to/dune-awakening-selfhost-docker if needed."
  exit 1
fi

exec "\$LAB_DIR/runtime/scripts/dune" "\$@"
EOF

chmod +x /usr/local/bin/dune

echo "Installed dune command:"
which dune
