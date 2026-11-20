"""
اسکرپ کانال عمومی تلگرام با HTTP ساده (بدون مرورگر).
خروجی: JSON لیست پست‌ها روی stdout.
"""

import json
import re
import sys

import httpx
from bs4 import BeautifulSoup

from quiet import in_quiet_hours
from send_to_worker import report_error, send_posts

CHANNELS = ["fanniBultan"]
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
    ),
    "Accept-Language": "fa-IR,fa;q=0.9",
}


def _image_url(msg) -> str:
    photo = msg.select_one(".tgme_widget_message_photo_wrap")
    if photo:
        style = photo.get("style", "")
        match = re.search(r"background-image\s*:\s*url\(\s*(['\"]?)(.*?)\1\s*\)", style, re.IGNORECASE)
        if match:
            url = match.group(2).strip()
            if url.startswith(("https://", "http://")):
                return url

    # بعضی قالب‌ها عکس را با img می‌گذارند؛ عکس پروفایل و تصویر داخل متن رسانه‌ی پست نیستند.
    for image in msg.select("img"):
        if image.find_parent(class_="tgme_widget_message_user"):
            continue
        if image.find_parent(class_="tgme_widget_message_text"):
            continue
        url = image.get("src") or image.get("data-src") or ""
        if url.startswith(("https://", "http://")):
            return url
    return ""


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
        image_url = _image_url(msg)
        time_node = msg.select_one("time")
        published = time_node.get("datetime", "") if time_node else ""
        if not data_post or (not text and not image_url):
            continue
        posts.append({
            "source": "telegram",
            "channel": name,
            "post_id": data_post,
            "text": text,
            "published": published,
            "image_url": image_url,
        })
    return posts


def main() -> int:
    if in_quiet_hours():
        print(json.dumps({"skipped": "quiet_hours"}, ensure_ascii=False))
        return 0

    failed = 0
    for ch in CHANNELS:
        try:
            posts = fetch_channel(ch)
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR fetch channel={ch} type={type(exc).__name__}", file=sys.stderr)
            report_error("telegram", ch, "fetch", f"{type(exc).__name__}: {exc}")
            failed += 1
            continue
        if not posts:
            # صفحه‌ی عمومی همیشه پست‌های اخیر رو داره؛ نبودنشون یعنی ساختار صفحه عوض شده
            print(f"ERROR parse channel={ch} no posts", file=sys.stderr)
            report_error("telegram", ch, "parse", "هیچ پستی در صفحه پیدا نشد")
            failed += 1
            continue
        try:
            result = send_posts("telegram", ch, posts)
            print(f"channel={ch} fetched={len(posts)} result={result}")
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR send channel={ch} type={type(exc).__name__}", file=sys.stderr)
            report_error("telegram", ch, "send", f"{type(exc).__name__}: {exc}")
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        report_error("telegram", "", "startup", f"{type(exc).__name__}: {exc}")
        raise
