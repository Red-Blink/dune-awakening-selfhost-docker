#!/usr/bin/env python3
"""Summarize a confirmed GitHub limit without exposing response credentials."""
import email.utils
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def summarize(headers_text, body, now=None):
    now = now or datetime.now(timezone.utc)
    headers = {}
    status = 0
    # Redirects/retries can contain several responses. Only the last counts.
    for line in headers_text.splitlines():
        if line.startswith("HTTP/"):
            headers = {}
            parts = line.split()
            status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        elif ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    message = ""
    try:
        payload = json.loads(body)
        if isinstance(payload, dict):
            message = str(payload.get("message", "")).lower()
    except (ValueError, TypeError):
        pass
    limited = status == 429 or (status == 403 and (
        headers.get("x-ratelimit-remaining") == "0"
        or "api rate limit exceeded" in message
        or "secondary rate limit" in message
    ))
    if not limited:
        return ""
    retry = None
    value = headers.get("retry-after", "")
    try:
        if value.isdigit() and len(value) <= 8:
            retry = now + timedelta(seconds=int(value))
        elif value:
            retry = email.utils.parsedate_to_datetime(value)
            if retry.tzinfo is None:
                retry = retry.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError, OverflowError):
        pass
    # Primary limits have an epoch reset header. It is not a secondary-limit
    # cooldown, so do not use it unless the primary budget is exhausted.
    if retry is None and headers.get("x-ratelimit-remaining") == "0":
        value = headers.get("x-ratelimit-reset", "")
        if value.isdigit() and len(value) <= 12:
            try:
                retry = datetime.fromtimestamp(int(value), timezone.utc)
            except (ValueError, OverflowError, OSError):
                pass
    advice = "Try again later; no retry time was provided."
    if retry is not None:
        if retry > now:
            advice = f"Try again after {retry.astimezone(timezone.utc):%Y-%m-%d %H:%M:%S} UTC."
        else:
            advice = "The reported retry time has passed. You can try again now."
    return f"GitHub request limit reached. {advice}"


if __name__ == "__main__":
    headers = Path(sys.argv[1]).read_text(errors="replace")
    body = Path(sys.argv[2]).read_text(errors="replace") if len(sys.argv) > 2 else ""
    print(summarize(headers, body))
