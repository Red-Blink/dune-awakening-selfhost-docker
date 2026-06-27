#!/usr/bin/env python3
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request

DUNE_ROOT = pathlib.Path(os.environ.get("DUNE_ROOT", "/srv/dune"))
SERVER_DIR = pathlib.Path(os.environ.get("DUNE_SERVER_DIR", "/srv/dune/server"))
STEAM_DIR = pathlib.Path(os.environ.get("DUNE_STEAM_DIR", "/srv/dune/steam"))
GENERATED_DIR = pathlib.Path(os.environ.get("DUNE_GENERATED_DIR", "/srv/dune/generated"))
DUNE_HOME = pathlib.Path(os.environ.get("DUNE_HOME", "/home/dune"))
STEAM_APP_ID = os.environ.get("STEAM_APP_ID", "4754530")
SERVER_TITLE = os.environ.get("SERVER_TITLE", "My Dune Server")
SERVER_REGION = os.environ.get("SERVER_REGION", "Europe")

try:
    MIN_FREE_GB = int(os.environ.get("DUNE_MIN_FREE_GB", "25"))
except ValueError:
    MIN_FREE_GB = 25

def run(cmd, check=True, user=None):
    printable = " ".join(str(x) for x in cmd)
    print(f"[dune] $ {printable}", flush=True)

    if user:
        cmd = ["runuser", "-u", user, "--"] + [str(x) for x in cmd]
    else:
        cmd = [str(x) for x in cmd]

    return subprocess.run(cmd, check=check)

def resolve_server_ip():
    value = os.environ.get("SERVER_IP", "auto").strip()

    if value and value.lower() != "auto":
        return value

    for resolver in [resolve_ipify_public_ip, resolve_ifconfig_public_ip]:
        ip = resolver()
        if ip:
            return ip

    return "UNKNOWN"

def resolve_ipify_public_ip():
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=10) as r:
            return r.read().decode("utf-8").strip()
    except Exception:
        return ""

def resolve_ifconfig_public_ip():
    try:
        with urllib.request.urlopen("https://ifconfig.me/ip", timeout=10) as r:
            return r.read().decode("utf-8").strip()
    except Exception:
        return ""

def ensure_dirs():
    for p in [DUNE_ROOT, SERVER_DIR, STEAM_DIR, GENERATED_DIR, DUNE_ROOT / "cache"]:
        p.mkdir(parents=True, exist_ok=True)

    (DUNE_HOME / ".steam").mkdir(parents=True, exist_ok=True)

    run(["chown", "-R", "dune:dune", str(DUNE_ROOT)], check=False)
    run(["chown", "-R", "dune:dune", str(DUNE_HOME)], check=False)

def verify_install_dirs_writable():
    ensure_dirs()

    checks = [
        SERVER_DIR,
        STEAM_DIR,
        GENERATED_DIR,
        DUNE_ROOT / "cache",
        DUNE_HOME / ".steam",
    ]

    failed = []
    for path in checks:
        marker = path / ".dune-write-test"
        result = run([
            "sh",
            "-lc",
            f"touch {sh_quote(marker)} && rm -f {sh_quote(marker)}",
        ], check=False, user="dune")
        if result.returncode != 0:
            failed.append(path)

    if failed:
        print("", flush=True)
        print("[dune] The game update cannot write to one or more install directories.", flush=True)
        print("[dune] SteamCMD runs as the local 'dune' user, so these paths must be writable by dune:", flush=True)
        for path in failed:
            print(f"[dune]   {path}", flush=True)
        print("", flush=True)
        print("[dune] This usually happens after Docker volumes were restored, moved, or created with the wrong owner.", flush=True)
        print("[dune] Automatic ownership repair was attempted but did not fix every path.", flush=True)
        print("", flush=True)
        print("[dune] Run this on the host, then retry the update:", flush=True)
        print("[dune]   docker exec -u root dune-orchestrator sh -lc 'chown -R dune:dune /srv/dune /home/dune'", flush=True)
        print("[dune]   runtime/scripts/update.sh install", flush=True)
        sys.exit(13)

def sh_quote(value):
    return "'" + str(value).replace("'", "'\"'\"'") + "'"

def check_free_space():
    if os.environ.get("DUNE_SKIP_DISK_CHECK", "").strip() == "1":
        print("[dune] Disk free-space check skipped by DUNE_SKIP_DISK_CHECK=1.", flush=True)
        return

    verify_install_dirs_writable()

    required_bytes = MIN_FREE_GB * 1024 * 1024 * 1024
    paths = [DUNE_ROOT, SERVER_DIR, STEAM_DIR, GENERATED_DIR, DUNE_ROOT / "cache"]
    checked = {}
    too_low = []

    print(f"[dune] Checking free disk space, required minimum: {MIN_FREE_GB} GiB", flush=True)

    for path in paths:
        existing = path if path.exists() else path.parent
        usage = shutil.disk_usage(existing)
        mount_key = (usage.total, usage.used, usage.free)
        if mount_key in checked:
            continue
        checked[mount_key] = True

        free_gb = usage.free / 1024 / 1024 / 1024
        total_gb = usage.total / 1024 / 1024 / 1024
        print(f"[dune] Disk space at {existing}: {free_gb:.1f} GiB free / {total_gb:.1f} GiB total", flush=True)

        if usage.free < required_bytes:
            too_low.append((str(existing), free_gb))

    if too_low:
        print("", flush=True)
        print("[dune] Not enough free disk space for a safe Dune server install/update.", flush=True)
        print("[dune] SteamDB currently lists the self-hosted server package as about 4.94 GiB download and 5.79 GiB installed before Docker image loading.", flush=True)
        print("[dune] This project also needs room for Docker images, volumes, database files, backups, and generated runtime data.", flush=True)
        print("[dune] Free disk space is below the configured safety minimum:", flush=True)
        for path, free_gb in too_low:
            print(f"[dune]   {path}: {free_gb:.1f} GiB free, needs at least {MIN_FREE_GB} GiB", flush=True)
        print("", flush=True)
        print("[dune] Free disk space or move Docker's data-root to a larger disk, then retry:", flush=True)
        print("[dune]   runtime/scripts/update.sh install", flush=True)
        print("[dune] Advanced override if you know there is enough external Docker storage:", flush=True)
        print("[dune]   DUNE_MIN_FREE_GB=10 runtime/scripts/update.sh install", flush=True)
        print("[dune]   DUNE_SKIP_DISK_CHECK=1 runtime/scripts/update.sh install", flush=True)
        sys.exit(3)

def ensure_steamcmd():
    verify_install_dirs_writable()

    steamcmd = STEAM_DIR / "steamcmd.sh"

    if steamcmd.exists():
        print("[dune] SteamCMD already installed.", flush=True)
        return

    print("[dune] Installing SteamCMD...", flush=True)

    tmp = pathlib.Path("/tmp/steamcmd_linux.tar.gz")

    run([
        "curl",
        "-fsSL",
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz",
        "-o",
        str(tmp),
    ])

    run(["tar", "-xzf", str(tmp), "-C", str(STEAM_DIR)])
    tmp.unlink(missing_ok=True)

    run(["chown", "-R", "dune:dune", str(STEAM_DIR), str(DUNE_HOME / ".steam")])
    run(["ln", "-sfn", str(STEAM_DIR), str(DUNE_HOME / ".steam" / "root")], user="dune")
    run(["ln", "-sfn", str(STEAM_DIR), str(DUNE_HOME / ".steam" / "steam")], user="dune")

def download():
    ensure_steamcmd()
    verify_install_dirs_writable()
    check_free_space()

    print(f"[dune] Downloading/updating Steam app {STEAM_APP_ID}", flush=True)
    print(f"[dune] Target directory: {SERVER_DIR}", flush=True)

    try:
        run([
            "env",
            f"HOME={DUNE_HOME}",
            str(STEAM_DIR / "steamcmd.sh"),
            "+@ShutdownOnFailedCommand", "1",
            "+@NoPromptForPassword", "1",
            "+@sSteamCmdForcePlatformType", "linux",
            "+force_install_dir", str(SERVER_DIR),
            "+login", "anonymous",
            "+app_update", STEAM_APP_ID, "validate",
            "+logoff",
            "+quit",
        ], user="dune")
    except subprocess.CalledProcessError as exc:
        print("", flush=True)
        print(f"[dune] SteamCMD app install failed with exit code {exc.returncode}.", flush=True)
        print("[dune] If SteamCMD printed \"state is 0x6\", common causes are:", flush=True)
        print("[dune]   - not enough free disk space in Docker's volume storage", flush=True)
        print("[dune]   - Steam temporarily refusing or failing the anonymous depot request", flush=True)
        print("[dune]   - Steam package/depot metadata changed and the local SteamCMD cache is stale", flush=True)
        print("[dune]   - network/CDN failure while contacting Steam", flush=True)
        print("", flush=True)
        print("[dune] Useful checks:", flush=True)
        print("[dune]   docker exec dune-orchestrator df -h /srv/dune/server /srv/dune/steam /srv/dune/cache", flush=True)
        print(f"[dune]   docker exec dune-orchestrator tail -n 80 {DUNE_HOME}/Steam/logs/stderr.txt", flush=True)
        print("", flush=True)
        print("[dune] Retry safely after fixing the cause:", flush=True)
        print("[dune]   runtime/scripts/update.sh install", flush=True)
        sys.exit(exc.returncode)

    print("[dune] Download finished.", flush=True)

def status():
    print("Dune Docker Orchestrator MVP")
    print(f"SERVER_IP={resolve_server_ip()}")
    print(f"SERVER_TITLE={SERVER_TITLE}")
    print(f"SERVER_REGION={SERVER_REGION}")
    print(f"STEAM_APP_ID={STEAM_APP_ID}")
    print(f"DUNE_ROOT={DUNE_ROOT}")
    print(f"SERVER_DIR={SERVER_DIR}")
    print(f"STEAM_DIR={STEAM_DIR}")
    print("")

    run(["docker", "version"], check=False)
    print("")
    run(["docker", "ps"], check=False)

def daemon():
    print("Dune Docker Orchestrator MVP daemon is running.", flush=True)
    print("Use: docker compose exec orchestrator dune status", flush=True)
    while True:
        time.sleep(3600)

def help_text():
    print("""
Usage:
  dune help       Show this help
  dune daemon     Keep the orchestrator container running
  dune preflight  Check disk space before downloading server files
  dune status     Verify Docker access and runtime config
  dune download   Download/update Dune server files with SteamCMD
""".strip())

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"

    if cmd == "status":
        status()
    elif cmd == "daemon":
        daemon()
    elif cmd == "preflight":
        check_free_space()
    elif cmd == "download":
        download()
    elif cmd in {"help", "--help", "-h"}:
        help_text()
    else:
        help_text()
        sys.exit(2)

if __name__ == "__main__":
    main()
