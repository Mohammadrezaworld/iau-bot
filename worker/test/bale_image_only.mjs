// اسکرپر بله: پست تصویری بدون کپشن نگه داشته می‌شود؛ پست بدون عکس و بدون متن کنار گذاشته می‌شود.
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

IMG = "https://file-gw1.ble.ir/proxy_download/a.jpg"
cards = [
    # تصویری بدون کپشن (فقط ساعت): باید نگه داشته شود با متن خالی
    {"sid": "r-1700000000001", "text": "۱۴:۳۰", "date": "", "images": [IMG]},
    # بدون کپشن و بدون عکس واقعی (placeholder): کنار گذاشته شود
    {"sid": "r-1700000000002", "text": "۱۴:۳۱", "date": "", "images": ["data:image/gif;base64,R0lG"]},
    # بدون عکس و بدون متن (فقط عدد): کنار گذاشته شود
    {"sid": "r-1700000000003", "text": "۴۱ ۷:۴۳", "date": "", "images": []},
    # متن کافی، بدون عکس: عادی
    {"sid": "r-1700000000004", "text": "کلاس فردا تشکیل نمی‌شود ۰۹:۰۰", "date": "", "images": []},
    # متن کافی و عکس: هر دو
    {"sid": "r-1700000000005", "text": "برنامه جدید ۱۲ ۱۰:۰۰", "date": "", "images": [IMG]},
]
posts = sb.posts_from_v2(cards, "iautcom")
by_id = {p["post_id"]: p for p in posts}
out = {}
out["image_only_kept"] = "r-1700000000001" in by_id
out["image_only_empty_text"] = by_id.get("r-1700000000001", {}).get("text") == ""
out["image_only_has_image"] = by_id.get("r-1700000000001", {}).get("image_url") == IMG
out["placeholder_only_dropped"] = "r-1700000000002" not in by_id
out["number_only_no_image_dropped"] = "r-1700000000003" not in by_id
out["text_post_no_image_kept"] = by_id.get("r-1700000000004", {}).get("image_url") == ""
out["text_with_image_kept_with_text"] = by_id.get("r-1700000000005", {}).get("text") == "برنامه جدید"
print(json.dumps(out))
`;
const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
let res = {};
try { res = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { res = {}; }
let fails = 0;
for (const [k, v] of Object.entries(res)) { console.log((v ? "PASS " : "FAIL ") + k); if (!v) fails++; }
if (r.status !== 0 || Object.keys(res).length < 7) { console.log("FAIL python: " + ((r.stderr || "") + (r.stdout || "")).slice(0, 400)); fails++; }
console.log(fails ? `FAILED ${fails}` : "ALL PASSED");
process.exit(fails ? 1 : 0);
