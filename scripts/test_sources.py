"""
تست دسترسی به منابع از داخل GitHub Actions.
فقط وضعیت و تعداد نشانه‌ها چاپ می‌شه، نه محتوای پست‌ها.
"""

import re
import sys

from playwright.sync_api import sync_playwright

SOURCES = [
    "https://ble.ir/s/iaut_fani",
    "https://ble.ir/s/iautcom",
    "https://t.me/s/fanniBultan",
]

TIME_RE = re.compile(r"\d{1,2}:\d{2}")


def check(page, url: str) -> None:
    try:
        response = page.goto(url, wait_until="networkidle", timeout=90_000)
        page.wait_for_timeout(8_000)
        status = response.status if response else "no-response"
        body = page.evaluate("() => document.body ? document.body.innerText : ''")
        title = page.title()
        times = len(TIME_RE.findall(body))
        print(f"{url} | status={status} | title={title!r} | body_chars={len(body)} | time_tokens={times}")
        print(f"  body_preview={body[:200]!r}")
    except Exception as exc:  # noqa: BLE001
        print(f"{url} | ERROR={type(exc).__name__}")


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 420, "height": 920},
            user_agent=(
                "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
            ),
            locale="fa-IR",
            timezone_id="Asia/Tehran",
        )
        page = context.new_page()
        for url in SOURCES:
            check(page, url)
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
