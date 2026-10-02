#!/usr/bin/env python3
"""Resolve the existing Console endpoint without executing its .env file."""
import fcntl
import os
import re
import shlex
import socket
import struct
from pathlib import Path


def console_upstream(values):
    host = values.get("ADMIN_BIND_HOST", "0.0.0.0").strip()
    if host in ("", "auto"):
        host = "127.0.0.1"
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            for _, name in socket.if_nameindex():
                try:
                    data = fcntl.ioctl(probe, 0x8915, struct.pack("256s", name.encode()[:15]))
                    address = socket.inet_ntoa(data[20:24])
                    a, b, *_ = map(int, address.split("."))
                    if a == 10 or a == 172 and 16 <= b <= 31 or a == 192 and b == 168 or a == 100 and 64 <= b <= 127:
                        host = address
                        break
                except OSError:
                    continue
    if host == "0.0.0.0":
        host = "127.0.0.1"
    elif host == "::":
        host = "::1"
    # Never turn an untrusted .env value into a URL authority or shell text.
    if ":" in host:
        socket.inet_pton(socket.AF_INET6, host)
    elif not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", host):
        raise ValueError("Invalid Console bind host")
    port = int(values.get("ADMIN_WEB_PORT") or values.get("ADMIN_BIND_PORT") or 8088)
    if not 1 <= port <= 65535:
        raise ValueError("Invalid Console port")
    return f"http://{'[' + host + ']' if ':' in host else host}:{port}"


if __name__ == "__main__":
    values = {}
    path = Path(".env")
    if path.exists():
        for line in path.read_text().splitlines():
            key, separator, raw = line.partition("=")
            if separator and key.strip() in ("ADMIN_BIND_HOST", "ADMIN_BIND_PORT", "ADMIN_WEB_PORT"):
                parts = shlex.split(raw, comments=True)
                if len(parts) == 1:
                    values[key.strip()] = parts[0]
    values.update({key: os.environ[key] for key in ("ADMIN_BIND_HOST", "ADMIN_BIND_PORT", "ADMIN_WEB_PORT") if key in os.environ})
    print(console_upstream(values))
