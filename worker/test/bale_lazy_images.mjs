// اسکرپر بله: کارت‌های آخر به دید می‌آیند و عکس lazy صبر می‌کند تا لود شود. تست با صفحه‌ی ساختگی؛ اسکرول زنده تست نمی‌شود.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
const py = `
import sys, types, json
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
pw = types.ModuleType("playwright"); sync = types.ModuleType("playwright.sync_api")
class PWTimeout(Exception): pass
sync.TimeoutError = PWTimeout; sync.sync_playwright = None
sys.modules["playwright"] = pw; sys.modules["playwright.sync_api"] = sync
import scrape_bale as sb

class Card:
    def __init__(self, img): self.img = img; self.scrolled = False
    def query_selector(self, sel): return object() if self.img else None
    def scroll_into_view_if_needed(self): self.scrolled = True
class Page:
    def __init__(self, cards, timeout=False): self.cards = cards; self.waits = []; self.timeout = timeout
    def query_selector_all(self, sel): return self.cards
    def wait_for_function(self, expr, arg=None, timeout=None):
        self.waits.append((expr, timeout))
        if self.timeout: raise PWTimeout("timeout")

out = {}
# ۲۵ کارت: ۵ کارت اول متنی، ۲۰ کارت آخر با عکس. فقط ۵ کارت آخر (جدیدترین‌ها) بررسی می‌شن
cards = [Card(False) for _ in range(5)] + [Card(True) for _ in range(20)]
p = Page(cards); sb.load_lazy_images(p)
out["only_last_5_scrolled"] = all(c.scrolled for c in cards[-5:]) and not any(c.scrolled for c in cards[:20])
out["waited_once_per_checked_image_card"] = len(p.waits) == 5
out["wait_checks_data_placeholder"] = all("data:" in e for e, _ in p.waits)
out["wait_within_total_budget"] = all(0 < t <= sb.LAZY_TOTAL_MS for _, t in p.waits) and all(a >= b for (_, a), (_, b) in zip(p.waits, p.waits[1:]))
# بعد از تایم‌اوت، خطا بالا نمی‌آید و بقیه‌ی کارت‌ها بی‌صبر رد می‌شن
q = Page([Card(True) for _ in range(3)], timeout=True)
try:
    sb.load_lazy_images(q); out["timeout_is_swallowed_and_stops"] = len(q.waits) == 1
except Exception:
    out["timeout_is_swallowed_and_stops"] = False
# سقف کل زمان: اگه از ددلاین گذشته باشیم، هیچ صبری انجام نمی‌شه
clock = iter([0.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0])
sb.time = types.SimpleNamespace(monotonic=lambda: next(clock))
r = Page([Card(True) for _ in range(3)]); sb.load_lazy_images(r)
out["deadline_stops_waiting"] = len(r.waits) == 0
sb.time = __import__("time")
# خروجی پارس قبلی همان می‌ماند: عکس http اول، پست بدون متن کنار گذاشته می‌شود
out["parse_unchanged"] = sb.posts_from_v2([{"sid": "r-1700000000000", "text": "متن کافی برای تست ۱۲:۰۰", "date": "", "images": ["https://x/a.jpg"]}], "c")[0]["image_url"] == "https://x/a.jpg"
print(json.dumps(out))
`;
const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
let res = {};
try { res = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { res = {}; }
let fails = 0;
for (const [k, v] of Object.entries(res)) { console.log((v ? "PASS " : "FAIL ") + k); if (!v) fails++; }
if (r.status !== 0 || Object.keys(res).length < 6) { console.log("FAIL python: " + ((r.stderr || "") + (r.stdout || "")).slice(0, 400)); fails++; }
console.log(fails ? `FAILED ${fails}` : "ALL PASSED");
process.exit(fails ? 1 : 0);
