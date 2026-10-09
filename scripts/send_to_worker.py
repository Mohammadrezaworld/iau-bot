"""
ارسال پست‌های اسکرپ‌شده به Worker (endpoint /ingest).
آدرس Worker و رمز از متغیرهای محیطی خونده میشن.
"""

import os

import httpx

WORKER_URL = os.environ.get("WORKER_URL", "https://iaut-bot.rimon24288.workers.dev")


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
