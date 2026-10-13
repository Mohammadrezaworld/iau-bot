"""
ارسال پست‌های اسکرپ‌شده به Worker (endpoint /ingest) و گزارش خطا (endpoint /scrape-report).
آدرس Worker و رمز از متغیرهای محیطی خونده میشن.
"""

import os
import re
import sys

import httpx

WORKER_URL = os.environ.get("WORKER_URL", "https://iaut-bot.rimon24288.workers.dev")
MAX_MESSAGE = 300

# الگوهای توکن: توکن ربات (شناسه:کلید) و توکن GitHub
_SECRET_PATTERNS = [
    re.compile(r"\d{6,}:[A-Za-z0-9_-]{20,}"),
    re.compile(r"(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]+"),
]


def redact(text: object, secret: str = "") -> str:
    out = str(text)
    if secret:
        out = out.replace(secret, "[redacted]")
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub("[redacted]", out)
    return " ".join(out.split())[:MAX_MESSAGE]


def send_posts(source: str, channel: str, posts: list[dict]) -> dict:
    secret = os.environ.get("INGEST_SECRET", "")
    if not secret:
        raise RuntimeError("INGEST_SECRET تنظیم نشده")

    resp = httpx.post(
        f"{WORKER_URL}/ingest",
        headers={"x-ingest-secret": secret, "content-type": "application/json"},
        json={"source": source, "channel": channel, "posts": posts},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def report_error(source: str, channel: str, stage: str, message: object) -> bool:
    """گزارش خطا به Worker. هیچ‌وقت exception نمی‌ندازه تا خود اسکرپ خراب نشه."""
    try:
        secret = os.environ.get("INGEST_SECRET", "")
        if not secret:
            print("report_error: INGEST_SECRET missing", file=sys.stderr)
            return False
        resp = httpx.post(
            f"{WORKER_URL}/scrape-report",
            headers={"x-ingest-secret": secret, "content-type": "application/json"},
            json={
                "source": source,
                "channel": channel,
                "stage": stage,
                "message": redact(message, secret),
            },
            timeout=20,
        )
        return resp.status_code == 200
    except Exception as exc:  # noqa: BLE001
        print(f"report_error failed type={type(exc).__name__}", file=sys.stderr)
        return False
