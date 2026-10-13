"""
اسکرپ صفحه پیش‌نمایش عمومی بله (ble.ir/s/<channel>) با Playwright.
خروجی: JSON لیست پست‌ها روی stdout.
"""

import hashlib
import json
import re
import sys

from playwright.sync_api import sync_playwright

from quiet import in_quiet_hours
from send_to_worker import report_error, send_posts

CHANNELS = ["iaut_fani", "iautcom"]
TIME_RE = re.compile(r"[0-9\u06F0-\u06F9]{1,2}:[0-9\u06F0-\u06F9]{2}")

# در مرورگر \d فقط ارقام انگلیسی رو می‌شناسه؛ ساعت‌های فارسی هم باید پیدا بشن
EXTRACT_JS = r"""
() => {
  const TIME_JS = /[0-9\u06F0-\u06F9]{1,2}:[0-9\u06F0-\u06F9]{2}/;
  const cards = [];
  const seen = new Set();
  for (const node of document.querySelectorAll("div, article, section, li")) {
    const text = (node.innerText || "").trim();
    if (!text || text.length < 3 || text.length > 1500) continue;
    if (!TIME_JS.test(text)) continue;
    const childHasTime = Array.from(node.children || []).some((c) => {
      const t = (c.innerText || "").trim();
      return TIME_JS.test(t) && t.length < text.length;
    });
    if (childHasTime) continue;
    const key = text.replace(/\s+/g, " ").slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    const images = Array.from(node.querySelectorAll("img"))
      .map((i) => i.currentSrc || i.src || "")
      .filter((u) => u && !u.startsWith("data:"));
    cards.push({ text, images });
  }
  return cards.slice(0, 60);
}
"""


def _post_id(channel: str, text: str) -> str:
    return hashlib.sha1(f"{channel}|{text}".encode()).hexdigest()[:16]


def page_debug(page) -> str:
    info = page.evaluate(
        "() => ({title: document.title, chars: (document.body && document.body.innerText || '').length,"
        " cards: document.querySelectorAll('div, article, section, li').length})"
    )
    return f"title={info['title']!r} chars={info['chars']} nodes={info['cards']}"


def fetch_channel(page, channel: str) -> list[dict]:
    url = f"https://ble.ir/s/{channel}"
    page.goto(url, wait_until="networkidle", timeout=90_000)
    page.wait_for_timeout(5_000)
    cards = page.evaluate(EXTRACT_JS)

    posts = []
    for card in cards:
        text = card.get("text", "")
        if not TIME_RE.search(text):
            continue
        posts.append({
            "source": "bale",
            "channel": channel,
            "post_id": _post_id(channel, text),
            "text": text,
            "image_url": next((u for u in card.get("images", []) if u.startswith("http")), ""),
        })
    return posts


def main() -> int:
    if in_quiet_hours():
        print(json.dumps({"skipped": "quiet_hours"}, ensure_ascii=False))
        return 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 420, "height": 920},
            locale="fa-IR",
            timezone_id="Asia/Tehran",
        )
        page = context.new_page()
        failed = 0
        for ch in CHANNELS:
            try:
                posts = fetch_channel(page, ch)
                if not posts:
                    # یک بار دیگر با انتظار بیشتر؛ بله گاهی دیر پست‌ها رو نشون می‌ده
                    page.wait_for_timeout(20_000)
                    posts = fetch_channel(page, ch)
            except Exception as exc:  # noqa: BLE001
                print(f"ERROR fetch channel={ch} type={type(exc).__name__}", file=sys.stderr)
                report_error("bale", ch, "fetch", f"{type(exc).__name__}: {exc}")
                failed += 1
                continue
            if not posts:
                # صفحه باز شده ولی هیچ پستی پیدا نشده: یا صفحه خالیه یا ساختارش عوض شده
                debug = page_debug(page)
                print(f"ERROR parse channel={ch} no posts {debug}", file=sys.stderr)
                report_error("bale", ch, "parse", f"هیچ پستی پیدا نشد ({debug})")
                failed += 1
                continue
            try:
                result = send_posts("bale", ch, posts)
                print(f"channel={ch} fetched={len(posts)} result={result}")
            except Exception as exc:  # noqa: BLE001
                print(f"ERROR send channel={ch} type={type(exc).__name__}", file=sys.stderr)
                report_error("bale", ch, "send", f"{type(exc).__name__}: {exc}")
                failed += 1
        browser.close()
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        # خطای راه‌اندازی (مثلاً مرورگر): گزارش بشه و اجرا همچنان قرمز بمونه
        report_error("bale", "", "startup", f"{type(exc).__name__}: {exc}")
        raise
