"""One way for the runtime scripts' embedded Python to reach the stack's database.

runtime/scripts/lib/postgres.sh is the same seam for shell callers, and the two
have to agree: one transport policy, one pair of environment variables, one
default port. This twin exists because the override publishers query from inside
`python3 - <<PY` blocks that each built a `docker exec` argv by hand. Those
blocks are the busiest query path in the stack -- two of them run in permanent
loops and fan out over every world partition -- and no amount of converting
shell call sites could reach them.

Configuration arrives through the environment, the way it does for a container.
The shell entrypoints export POSTGRES_PORT and DUNE_PSQL_TRANSPORT out of .env
before they run Python, because a plain `. ./.env` leaves both invisible to a
child process.
"""

import os
import shutil
import subprocess

# How start-postgres.sh provisions the server. Stated in lib/postgres.sh too;
# tests/psql-transport-test.sh asserts the two never drift apart.
SUPERUSER = "postgres"
SUPERUSER_PASSWORD = "postgres"
DATABASE = "dune"
CONTAINER = "dune-postgres"
DEFAULT_PORT = 15432

_resolved = None


def _port():
    """The published port, validated the way lib/ports.sh validates it.

    The shipped default applies when the variable is unset or empty; anything
    else that is not a port is a configuration error rather than a silent
    fallback, so a typo in .env cannot quietly point the stack somewhere else.
    """
    value = os.environ.get("POSTGRES_PORT") or str(DEFAULT_PORT)
    if value.isdigit() and 1 <= int(value) <= 65535:
        return value
    raise ValueError(f"Invalid POSTGRES_PORT={value}; expected TCP/UDP port 1-65535.")


def _resolve():
    """Settle the transport and the port once per process, on the first query.

    Deferring matters for the same reason it does in the shell seam: importing
    this module must not pin an answer before the caller has finished reading its
    configuration. Neither answer can change while a process runs.
    """
    global _resolved
    if _resolved is not None:
        return _resolved

    transport = os.environ.get("DUNE_PSQL_TRANSPORT") or "auto"
    if transport == "auto":
        # shutil.which is the analogue of the shell seam's `type -P`: it finds a
        # real executable on PATH and cannot be fooled by a shell function named
        # psql, which this repo used to carry.
        transport = "tcp" if shutil.which("psql") else "exec"
    elif transport not in ("tcp", "exec"):
        raise ValueError(
            f"Invalid DUNE_PSQL_TRANSPORT={transport}; expected auto, tcp or exec."
        )

    _resolved = (transport, _port())
    return _resolved


def resolved_transport():
    """Which leg this process would use, for doctor.sh to report.

    The shell seam answers the same question by exposing DUNE_PSQL_TRANSPORT
    after dune_psql_init. Asking is not the same as looking for a psql client:
    an explicit setting can pin the exec path on an image that has one, and a
    check that inferred the answer would report the opposite of what runs.
    """
    return _resolve()[0]


def query_tsv(sql):
    """Run one statement and return its rows unaligned and tab-separated.

    Every caller wants exactly this shape -- it is the `-At -F '\\t' -c` that the
    hand-built argv lists all spelled out -- so the seam offers it directly
    instead of an argument passthrough nobody would use.
    """
    transport, port = _resolve()
    tail = ["-At", "-F", "\t", "-c", sql]
    env = os.environ.copy()

    if transport == "tcp":
        argv = [
            "psql",
            "-h", "127.0.0.1",
            "-p", port,
            "-U", SUPERUSER,
            "-d", DATABASE,
            *tail,
        ]
        env["PGPASSWORD"] = SUPERUSER_PASSWORD
    else:
        argv = [
            "docker", "exec", CONTAINER,
            "psql",
            "-U", SUPERUSER,
            "-d", DATABASE,
            *tail,
        ]

    # stdin is closed for the same reason the shell seam redirects it: these
    # queries run inside loops that are reading from stdin themselves, and a
    # psql started over TCP is a direct child that would otherwise drain it.
    return subprocess.run(
        argv,
        check=True,
        text=True,
        capture_output=True,
        stdin=subprocess.DEVNULL,
        env=env,
    ).stdout
