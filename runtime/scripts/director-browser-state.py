"""Confirm sustained browser failure using only post-repair declarations.

No log text, identifiers or payloads are persisted or printed.
"""
import argparse
from datetime import datetime
import json
import sys


def failure_confirmed(lines, after, now, grace):
    reports = {}
    for line in lines:
        if "Population declaration:" not in line:
            continue
        try:
            stamp = datetime.fromisoformat(line.split(" ", 1)[0].replace("Z", "+00:00")).timestamp()
            if not after < stamp <= now:
                continue
            payload = json.loads(line.split("Population declaration:", 1)[1])
            capacity = payload.get("BattlegroupMaxPlayerCapacity")
            # Invalid, locked or incomplete reports do not confirm failure.
            reports[stamp] = (type(capacity) is int and capacity == 0
                              and payload.get("IsLocked") is False)
        except (ValueError, TypeError, AttributeError, IndexError):
            continue
    first_zero = None
    last_zero = None
    for stamp, zero in sorted(reports.items()):
        if not zero:
            first_zero = last_zero = None
        else:
            if first_zero is None:
                first_zero = stamp
            last_zero = stamp
    return (first_zero is not None and last_zero is not None
            and last_zero - first_zero >= 60
            and last_zero >= after + max(120, grace)
            and now - last_zero <= 90)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--after", type=int, required=True)
    parser.add_argument("--now", type=int, required=True)
    parser.add_argument("--grace", type=int, required=True)
    args = parser.parse_args()
    sys.exit(0 if failure_confirmed(sys.stdin, args.after, args.now, args.grace) else 1)
