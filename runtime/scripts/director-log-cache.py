"""One reconnecting Director follower; indexed, recent snapshots for scanners.

The private cache belongs to one Autoscaler process, not to a game generation.
Container replacement invalidates old evidence. A dead follower fails closed.
"""

import argparse
import contextlib
from datetime import datetime
import os
from pathlib import Path
import re
import selectors
import signal
import sqlite3
import subprocess
import sys
import time


def seconds(value):
    match = re.fullmatch(r"([1-9][0-9]*)([smh]?)", value)
    if not match:
        raise ValueError("Invalid Director log window")
    return int(match[1]) * {"": 1, "s": 1, "m": 60, "h": 3600}[match[2]]


def connect(path):
    db = sqlite3.connect(path, timeout=5)
    db.execute("pragma journal_mode=WAL")
    db.execute("pragma synchronous=NORMAL")
    db.execute("pragma temp_store=MEMORY")
    db.executescript("""
        create table if not exists logs (id integer primary key autoincrement, stamp real, line text);
        create index if not exists log_stamp on logs(stamp);
        create table if not exists state (id integer primary key check(id=1),
            heartbeat real, generation text, connected integer);
    """)
    return db


def append(db, lines):
    rows = []
    for line in lines:
        try:
            timestamp = line.split(" ", 1)[0]
            stamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
        except (ValueError, IndexError):
            continue
        rows.append((stamp, line))
    db.executemany("insert into logs(stamp,line) values (?,?)", rows)


def snapshot(db, window, timestamps=False, now=None):
    now = time.time() if now is None else now
    state = db.execute("select heartbeat,generation,connected from state where id=1").fetchone()
    if not state or not state[2] or now - state[0] > 15:
        raise RuntimeError("Director log follower is unavailable; deferring log-based scans")
    rows = db.execute(
        "select line from logs where stamp >= ? order by id", (now - window,)
    )
    return [row[0] if timestamps else row[0].partition(" ")[2] for row in rows]


def container_id():
    result = subprocess.run(
        ["docker", "inspect", "--format", "{{.Id}} {{.State.Running}}", "dune-director"],
        capture_output=True, text=True, timeout=5, check=False,
    )
    fields = result.stdout.strip().split()
    return fields[0] if result.returncode == 0 and len(fields) == 2 and fields[1] == "true" else ""


def follow(path, retention, parent):
    os.umask(0o077)
    db = connect(path)
    Path(path).chmod(0o600)
    db.execute("update state set connected=0")
    db.commit()
    process = None
    selector = selectors.DefaultSelector()
    generation = ""
    buffer = b""
    next_probe = 0
    next_flush = 0
    next_prune = 0
    dirty_logs = False
    stopped = False

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopped and os.getppid() == parent:
            now = time.time()
            if now >= next_probe:
                next_probe = now + 5
                try:
                    current = container_id()
                except (OSError, subprocess.TimeoutExpired):
                    current = ""
                if process and (current != generation or process.poll() is not None):
                    selector.unregister(process.stdout)
                    process.terminate()
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        process.wait(timeout=2)
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    process.stdout.close()
                    process = None
                    buffer = b""
                if not process and current:
                    # Replay a bounded TIME window once on connection, not on
                    # every scan. Reset even on reconnect: no duplicate events.
                    db.execute("delete from logs")
                    generation = current
                    process = subprocess.Popen(
                        ["docker", "logs", "--follow", "--timestamps", "--since",
                         f"{retention}s", generation], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                    )
                    selector.register(process.stdout, selectors.EVENT_READ)
            for key, _ in selector.select(timeout=0.25):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if chunk:
                    buffer += chunk
                    lines = buffer.split(b"\n")
                    buffer = lines.pop()
                    if lines:
                        append(db, [line.decode("utf-8", errors="replace") for line in lines])
                        dirty_logs = True
                else:
                    next_probe = 0
            if now >= next_flush:
                next_flush = now + 1
                if dirty_logs or now >= next_prune:
                    db.execute("delete from logs where stamp < ?", (now - retention,))
                    dirty_logs = False
                    next_prune = now + 10
                db.execute("insert or replace into state values (1,?,?,?)",
                           (now, generation, int(process is not None and process.poll() is None)))
                db.commit()
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            process.stdout.close()
        db.execute("update state set connected=0")
        db.commit()
        db.close()
        selector.close()


def stream(path, parent):
    db = None
    generation = None
    cursor = 0
    try:
        while True:
            try:
                os.kill(parent, 0)
            except ProcessLookupError:
                return
            try:
                if db is None:
                    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
                snapshot(db, 1)
                current = db.execute("select generation from state where id=1").fetchone()[0]
                if current != generation:
                    generation = current
                    cursor = db.execute("select coalesce(max(id),0) from logs").fetchone()[0]
                for row_id, log_line in db.execute("select id,line from logs where id > ? order by id", (cursor,)):
                    print(log_line.partition(" ")[2], flush=True)
                    cursor = row_id
            except (sqlite3.Error, RuntimeError):
                # Startup and reconnects are normal, not a reason to terminate
                # the consumer. Do not emit stale cached evidence while down.
                if db is not None:
                    db.close()
                db = None
            time.sleep(0.25)
    finally:
        if db is not None:
            db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("follow", "read", "stream"))
    parser.add_argument("path")
    parser.add_argument("--retention", type=int, default=600)
    parser.add_argument("--parent", type=int, default=os.getppid())
    parser.add_argument("--since", default="30s")
    parser.add_argument("--timestamps", action="store_true")
    args = parser.parse_args()
    if args.mode == "follow":
        follow(args.path, args.retention, args.parent)
    elif args.mode == "stream":
        stream(args.path, args.parent)
    else:
        # Readers never create or repair a missing cache.
        db = sqlite3.connect(Path(args.path).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            for line in snapshot(db, seconds(args.since), args.timestamps):
                print(line)
        finally:
            db.close()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
