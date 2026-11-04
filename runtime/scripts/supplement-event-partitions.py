#!/usr/bin/env python3
"""Temporary self-host partition omissions; upstream definitions always win."""

import json
from pathlib import Path
import subprocess
import sys


EVENT_MAP = "CB_Halloween_Event_Shipwreck_01"


def supplement(rows, image):
    if not isinstance(rows, list) or not rows:
        raise ValueError("Cannot supplement an empty or invalid partition catalog")
    if any(str(row.get("map", "")).casefold() == EVENT_MAP.casefold() for row in rows):
        return rows

    # Check the actual selected server image, without starting the game, mounting
    # host state, or granting network access. The IoStore index contains filenames.
    result = subprocess.run(
        ["docker", "run", "--rm", "--pull=never", "--network=none", "--read-only", "--user=dune",
         "--cap-drop=ALL", "--security-opt=no-new-privileges", "--entrypoint=/bin/sh",
         image, "-c",
         'index=/home/dune/server/DuneSandbox/Content/Paks/pakchunk170-LinuxServer.utoc; '
         '[ -x "$(dirname "$index")" ] || exit 2; '
         'if [ ! -e "$index" ]; then exit 1; fi; '
         '[ -r "$index" ] || exit 2; '
         'grep -aFq "CB_Halloween_Event_Shipwreck_01.umap" "$index"'],
        capture_output=True, text=True, timeout=60, check=False,
    )
    if result.returncode == 1:
        print("Skipping Hieronymus fallback: event map is absent from the server image.", file=sys.stderr)
        return rows
    if result.returncode != 0:
        # Do not publish an incomplete catalog after a Docker/image/read failure.
        raise RuntimeError("Could not inspect the server image for the Hieronymus map")

    print("Adding temporary Hieronymus partition omitted from Funcom's template.", file=sys.stderr)
    return rows + [{
        "map": EVENT_MAP, "id": None, "dimension": 0, "disable": False,
        "minX": 0, "minY": 0, "maxX": 1, "maxY": 1,
    }]


def main():
    if len(sys.argv) != 3:
        raise ValueError("Usage: supplement-event-partitions.py CATALOG SERVER_IMAGE")
    path = Path(sys.argv[1])
    rows = supplement(json.loads(path.read_text()), sys.argv[2])
    path.write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"Cannot supplement event partitions: {exc}", file=sys.stderr)
        sys.exit(1)
