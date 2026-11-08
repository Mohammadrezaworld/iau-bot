"""
اسکرپ صفحه پیش‌نمایش عمومی بله (ble.ir/s/<channel>) با Playwright.
خروجی: JSON لیست پست‌ها روی stdout.
"""

import hashlib
import json
import re
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from playwright.sync_api import TimeoutError as PWTimeout
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


# فوتر کارت: یک یا چند عدد (بازدید/واکنش) و بعد ساعت، در انتهای متن
FOOTER_RE = re.compile(r"(?:\s+[0-9\u06F0-\u06F9]+)+\s+[0-9\u06F0-\u06F9]{1,2}:[0-9\u06F0-\u06F9]{2}\s*$")


def clean_post_text(raw: str) -> str | None:
    """متن پست بدون فوتر. اگه بعد از حذف فوتر کمتر از ۳ حرف بمونه (مثل «۴۱ ۷:۴۳»)، None."""
    text = " ".join(str(raw).split())
    text = FOOTER_RE.sub("", text).strip()
    if len(re.findall(r"[^\W\d_]", text)) < 3:
        return None
    return text


def _post_id(channel: str, text: str) -> str:
    return hashlib.sha1(f"{channel}|{text}".encode()).hexdigest()[:16]


def fetch_with_retry(page, channel: str) -> list[dict]:
    """یک بار تلاش مجدد پس از ۲۰ ثانیه، اگه صفحه تایم‌اوت شد یا هیچ پستی پیدا نشد."""
    for attempt in range(2):
        try:
            posts = fetch_channel(page, channel)
            if posts:
                return posts
            error = None
        except Exception as exc:  # noqa: BLE001
            error = exc
        if attempt == 0:
            page.wait_for_timeout(20_000)
    if error is not None:
        raise error
    return []


def page_debug(page) -> str:
    info = page.evaluate(
        "() => ({title: document.title, chars: (document.body && document.body.innerText || '').length,"
        " cards: document.querySelectorAll('div, article, section, li').length})"
    )
    return f"title={info['title']!r} chars={info['chars']} nodes={info['cards']}"


TEHRAN = ZoneInfo("Asia/Tehran")
# پست‌های شب (از ۲۳:۳۰ به بعد) برای روز بعد حساب می‌شن: با این جابه‌جایی، پست ۲۳:۳۰ امروز = فردا.
# گروه تا ۰۲:۰۰ باز است؛ پستی که ساعت ۰۲ به بعد بیاد، تا ۰۶ صبح بعد صبر می‌کنه و همون روز ارسال می‌شه.
NIGHT_SHIFT = timedelta(minutes=30)

# ساختار جدید صفحه: هر پیام یک بلوک با data-sid (شناسه‌ی ثابت) و جداکننده‌ی روز با datetime (UTC).
# همه‌ی گره‌ها به ترتیب صفحه خونده می‌شن تا تاریخ هر پیام از نزدیک‌ترین جداکننده‌ی بالاش گرفته بشه.
EXTRACT_V2_JS = r"""
() => {
  const out = [];
  let currentDate = "";
  const nodes = document.querySelectorAll('time[datetime], [class*="MessageItem_messageWrapper"]');
  for (const n of nodes) {
    if (n.tagName === "TIME") { currentDate = n.getAttribute("datetime") || currentDate; continue; }
    const text = (n.innerText || "").trim();
    if (!text) continue;
    const images = Array.from(n.querySelectorAll("img"))
      .filter((i) => Math.max(i.naturalWidth, i.width) >= 200)
      .map((i) => i.currentSrc || i.src || "")
      .filter((u) => u && !u.startsWith("data:"));
    out.push({ sid: n.getAttribute("data-sid") || "", date: currentDate, text, images });
  }
  return out.slice(-80);
}
"""


def tehran_date(iso: str) -> str:
    """تاریخ تهران (YYYY-MM-DD) از datetime جداکننده‌ی UTC؛ خالی اگه معلوم نیست."""
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return (dt.astimezone(TEHRAN) + NIGHT_SHIFT).date().isoformat()


def date_from_sid(sid: str) -> str:
    """تاریخ تهران (YYYY-MM-DD) از پسوند ms شناسه‌ی پیام (data-sid = rid-ms). خالی اگه پسوند نباشه.
    این تاریخ خود پیام‌ه، پس به جداکننده‌ی روز (که ممکنه پیام‌های بعد از نیمه‌شب رو زیر روز قبلی بذاره) وابسته نیست."""
    m = re.search(r"-(\d{13})$", sid or "")
    if not m:
        return ""
    return (datetime.fromtimestamp(int(m.group(1)) / 1000, TEHRAN) + NIGHT_SHIFT).date().isoformat()


def posts_from_v2(cards: list[dict], channel: str) -> list[dict]:
    posts = []
    seen = set()
    for card in cards:
        sid = str(card.get("sid") or "")
        raw = card.get("text", "")
        if not sid or sid in seen or not TIME_RE.search(raw):
            continue
        text = clean_post_text(raw)
        if text is None:
            continue
        seen.add(sid)
        posts.append({
            "source": "bale",
            "channel": channel,
            "post_id": sid,
            "text": text,
            # اول تاریخ خود پیام (از sid)؛ اگه نبود، تاریخ جداکننده‌ی روز
            "post_date": date_from_sid(sid) or tehran_date(card.get("date", "")),
            "image_url": next((u for u in card.get("images", []) if u.startswith("http")), ""),
        })
    return posts


# فید بله lazy است: تا وقتی کارت به دید نیاد، عکسش placeholder (data:) است. فقط چند کارت آخر (جدیدترین‌ها) رو می‌آریم.
LAZY_CARDS = 5
LAZY_TOTAL_MS = 15_000
IMG_LOADED_JS = "(el) => { const i = el.querySelector('img'); return !i || (!i.src.startsWith('data:') && i.complete && i.naturalWidth > 0); }"


def load_lazy_images(page) -> None:
    # سقف کل صبر برای همه‌ی عکس‌ها با هم (نه برای هر عکس)؛ بعد از سقف، ادامه بدون صبر بیشتر
    deadline = time.monotonic() + LAZY_TOTAL_MS / 1000
    for card in page.query_selector_all('[class*="MessageItem_messageWrapper"]')[-LAZY_CARDS:]:
        if card.query_selector("img") is None:
            continue
        card.scroll_into_view_if_needed()
        left_ms = int((deadline - time.monotonic()) * 1000)
        if left_ms <= 0:
            break
        try:
            page.wait_for_function(IMG_LOADED_JS, arg=card, timeout=left_ms)
        except PWTimeout:
            break


def fetch_channel(page, channel: str) -> list[dict]:
    url = f"https://ble.ir/s/{channel}"
    # networkidle روی صفحه‌ی بله گاهی هیچ‌وقت نمی‌رسه؛ با domcontentloaded و انتظار کوتاه برای پست‌ها
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(8_000)
    load_lazy_images(page)
    # اول ساختار جدید (با data-sid و تاریخ)؛ اگه نبود، ساختار قبلی
    posts = posts_from_v2(page.evaluate(EXTRACT_V2_JS), channel)
    if posts:
        return posts
    cards = page.evaluate(EXTRACT_JS)

    posts = []
    seen = set()
    for card in cards:
        raw = card.get("text", "")
        if not TIME_RE.search(raw):
            continue
        text = clean_post_text(raw)
        if text is None or text in seen:
            continue
        seen.add(text)
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
                posts = fetch_with_retry(page, ch)
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
