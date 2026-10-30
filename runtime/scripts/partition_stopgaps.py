#!/usr/bin/env python3
"""Temporary partitions for maps a game build ships before Funcom's world template lists them.

Without a world partition such a map never gets a server and players cannot
travel into it. Each entry retires itself: it is skipped once the template lists
the map and dimension, or when the installed game image no longer ships the map.
Delete an entry once Funcom's template carries it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

STOPGAP_PARTITIONS = (
    {
        # Halloween 2026 event dungeon "Wreck of the Hieronymus" (issue #268).
        "map": "CB_Halloween_Event_Shipwreck_01",
        "dimension": 0,
        "umap": "CB_Halloween_Event_Shipwreck_01.umap",
    },
)


def umap_names() -> list[str]:
    return [entry["umap"] for entry in STOPGAP_PARTITIONS]


def apply_stopgaps(rows: list[dict], shipped_umaps: set[str]) -> tuple[list[dict], list[str]]:
    present = {(str(row.get("map", "")).casefold(), int(row.get("dimension") or 0)) for row in rows}
    next_id = max((int(row["id"]) for row in rows), default=0) + 1
    merged = list(rows)
    notes = []

    for entry in STOPGAP_PARTITIONS:
        map_name = entry["map"]
        dimension = entry["dimension"]
        if (map_name.casefold(), dimension) in present:
            notes.append(f"Stopgap partition not needed: world template already lists {map_name} dimension {dimension}")
            continue
        if entry["umap"] not in shipped_umaps:
            notes.append(f"Stopgap partition skipped: installed game build does not ship {entry['umap']}")
            continue
        merged.append({
            "map": map_name,
            "id": next_id,
            "dimension": dimension,
            "disable": False,
            "minX": 0,
            "minY": 0,
            "maxX": 1,
            "maxY": 1,
            "stopgap": True,
        })
        present.add((map_name.casefold(), dimension))
        notes.append(f"Added stopgap partition: {map_name} dimension {dimension} (catalog ID {next_id})")
        next_id += 1

    return merged, notes


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "umaps":
        for name in umap_names():
            print(name)
        return 0

    if len(argv) >= 3 and argv[1] == "apply":
        catalog = Path(argv[2])
        rows = json.loads(catalog.read_text())
        if not isinstance(rows, list):
            print("partition catalog must contain a JSON array", file=sys.stderr)
            return 1
        merged, notes = apply_stopgaps(rows, set(argv[3:]))
        for note in notes:
            print(note, file=sys.stderr)
        if merged != rows:
            catalog.write_text(json.dumps(merged, indent=2) + "\n")
        return 0

    print(f"Usage: {Path(argv[0]).name} umaps | apply CATALOG [SHIPPED_UMAP...]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
