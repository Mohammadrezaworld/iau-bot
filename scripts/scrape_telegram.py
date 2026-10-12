"""
اسکرپ کانال عمومی تلگرام با HTTP ساده (بدون مرورگر).
خروجی: JSON لیست پست‌ها روی stdout.
"""

import json
import sys

import httpx
from bs4 import BeautifulSoup

from send_to_worker import send_posts

CHANNELS = ["fanniBultan"]
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
    ),
    "Accept-Language": "fa-IR,fa;q=0.9",
}


def fetch_channel(name: str) -> list[dict]:
    url = f"https://t.me/s/{name}"
    resp = httpx.get(url, headers=HEADERS, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    posts = []
    for msg in soup.select("div.tgme_widget_message"):
        data_post = msg.get("data-post", "")  # مثلاً fanniBultan/582
        text_node = msg.select_one("div.tgme_widget_message_text")
        text = text_node.get_text("\n", strip=True) if text_node else ""
        time_node = msg.select_one("time")
        published = time_node.get("datetime", "") if time_node else ""
        if not data_post:
            continue
        posts.append({
            "source": "telegram",
            "channel": name,
            "post_id": data_post,
            "text": text,
            "published": published,
            "image_url": "",  # عکس‌ها در مرحله بعد اضافه میشن
        })
    return posts


def main() -> int:
    failed = 0
    for ch in CHANNELS:
        try:
            posts = fetch_channel(ch)
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR fetch channel={ch} type={type(exc).__name__}", file=sys.stderr)
            failed += 1
            continue
        try:
            result = send_posts("telegram", ch, posts)
            print(f"channel={ch} fetched={len(posts)} result={result}")
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR send channel={ch} type={type(exc).__name__}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
