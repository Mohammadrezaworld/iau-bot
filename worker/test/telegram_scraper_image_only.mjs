// اسکرپر تلگرام: fixture واقعی fanniBultan/100، عکسِ تنها حفظ و پستِ بی‌متن/بی‌عکس حذف می‌شود.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, "..", "..", "scripts");
const fixture = join(here, "fixtures", "telegram_image_only.html");
const py = `
import json, sys, types
from pathlib import Path
from bs4 import BeautifulSoup

sys.path.insert(0, ${JSON.stringify(scripts)})
fixture_html = Path(${JSON.stringify(fixture)}).read_text(encoding="utf-8")
html = fixture_html + """
<div class="tgme_widget_message" data-post="fixture/empty"></div>
<div class="tgme_widget_message" data-post="fixture/avatar-only">
  <div class="tgme_widget_message_user"><img src="https://img.example/avatar.jpg"></div>
</div>
<div class="tgme_widget_message" data-post="fixture/img-fallback">
  <div class="tgme_widget_message_bubble"><div class="tgme_widget_message_media">
    <img src="https://img.example/fallback.jpg">
  </div></div>
</div>
<div class="tgme_widget_message" data-post="fixture/short-text">
  <div class="tgme_widget_message_text">x</div>
</div>
"""

# اسکرپر برای این تست فقط HTML fixture می‌خواند؛ هیچ درخواست شبکه‌ای انجام نمی‌شود.
httpx = types.ModuleType("httpx")
class Response:
    text = html
    def raise_for_status(self): pass
httpx.get = lambda *args, **kwargs: Response()
sys.modules["httpx"] = httpx
sender = types.ModuleType("send_to_worker")
sender.report_error = lambda *args, **kwargs: None
sender.send_posts = lambda *args, **kwargs: None
sys.modules["send_to_worker"] = sender

import scrape_telegram as scraper
posts = scraper.fetch_channel("fanniBultan")
by_id = {post["post_id"]: post for post in posts}
real_photo = BeautifulSoup(fixture_html, "html.parser").select_one(".tgme_widget_message_photo_wrap")
style = real_photo.get("style", "")
expected_real_url = style.split("url('", 1)[1].split("')", 1)[0]
out = {
    "real_fanniBultan_image_only_kept": "fanniBultan/100" in by_id and by_id["fanniBultan/100"]["text"] == "",
    "real_photo_wrap_background_image_extracted": by_id.get("fanniBultan/100", {}).get("image_url") == expected_real_url,
    "img_fallback_extracted": by_id.get("fixture/img-fallback", {}).get("image_url") == "https://img.example/fallback.jpg",
    "empty_without_image_omitted": "fixture/empty" not in by_id,
    "avatar_img_not_mistaken_for_post_photo": "fixture/avatar-only" not in by_id,
    "short_text_kept": by_id.get("fixture/short-text", {}).get("text") == "x",
}
print(json.dumps(out, ensure_ascii=False))
`;
const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
let out = {};
try { out = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { out = {}; }
let fails = 0;
if (r.status !== 0) {
  console.log("FAIL python scraper: " + ((r.stderr || "") + (r.stdout || "")).slice(0, 500));
  fails++;
}
for (const [name, passed] of Object.entries(out)) {
  console.log((passed ? "PASS " : "FAIL ") + name);
  if (!passed) fails++;
}
if (Object.keys(out).length !== 6) {
  console.log("FAIL expected 6 scraper checks");
  fails++;
}
console.log(fails ? `FAILED ${fails}` : "ALL PASS");
process.exit(fails ? 1 : 0);
