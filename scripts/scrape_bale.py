"""
اسکرپ صفحه پیش‌نمایش عمومی بله (ble.ir/s/<channel>) با Playwright.
خروجی: JSON لیست پست‌ها روی stdout.
"""

import hashlib
import json
import re
import sys

from playwright.sync_api import sync_playwright

from send_to_worker import send_posts

CHANNELS = ["iaut_fani", "iautcom"]
TIME_RE = re.compile(r"\d{1,2}:\d{2}")

EXTRACT_JS = r"""
() => {
  const cards = [];
  const seen = new Set();
  for (const node of document.querySelectorAll("div, article, section, li")) {
    const text = (node.innerText || "").trim();
    if (!text || text.length < 3 || text.length > 1500) continue;
    if (!/\d{1,2}:\d{2}/.test(text)) continue;
    const childHasTime = Array.from(node.children || []).some((c) => {
      const t = (c.innerText || "").trim();
      return /\d{1,2}:\d{2}/.test(t) && t.length < text.length;
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
            except Exception as exc:  # noqa: BLE001
                print(f"ERROR fetch channel={ch} type={type(exc).__name__}", file=sys.stderr)
                failed += 1
                continue
            try:
                result = send_posts("bale", ch, posts)
                print(f"channel={ch} fetched={len(posts)} result={result}")
            except Exception as exc:  # noqa: BLE001
                print(f"ERROR send channel={ch} type={type(exc).__name__}", file=sys.stderr)
                failed += 1
        browser.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
