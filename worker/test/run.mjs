// اجرای همه‌ی تست‌های worker. نیاز به Node 22+ (node:sqlite). ساعت روی ۱۲:۰۰ تهران ثابت می‌شه تا نتیجه به ساعت واقعی وابسته نباشه.
// استفاده: node worker/test/run.mjs
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  "webhook_v2.mjs", // صف webhook، lease، effects، مهاجرت (SQLite محلی)
  "batch_approval.mjs", // دسته‌های اسکرپ، ادامه، نتیجه‌ی مبهم، سیل، ساعت سکوت
  "flood_guard.mjs", // محافظ سیل و حالت آزمایشی
  "dm_menu.mjs", // منوی پیوی
  "group_moved.mjs", // پیام انتقال گروه
  "group_guidance.mjs", // راهنمای گروه
  "quiet_all.mjs", // ساعت سکوت: گروه ساکت، پیوی فعال
];

let failed = 0;
for (const s of SUITES) {
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    QTEST_DB: join(tmpdir(), `iaut-test-${s}.db`),
    TEHRAN_HOUR: "3", // quiet_all: ساعت ۰۳ باید سکوت باشه
  };
  const r = spawnSync(process.execPath, ["-r", join(here, "noon_preload.cjs"), join(here, s)], { env, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  let ok = r.status === 0 && !/^FAIL/m.test(out);
  if (s === "quiet_all.mjs") {
    // این تست خروجی خط‌به‌خط می‌ده؛ گروه باید silent و پیوی answered باشه
    const lines = out.split("\n").filter((l) => /→/.test(l));
    ok = lines.length > 0 && lines.every((l) => (/group/.test(l) ? /→ silent/.test(l) : /→ answered|SILENT\(bad\)/.test(l) ? !/SILENT\(bad\)/.test(l) : false));
  }
  const passed = (out.match(/^PASS/gm) || []).length;
  console.log(`${ok ? "OK  " : "FAIL"} ${s} (PASS lines: ${passed})`);
  if (!ok) { failed += 1; console.log(out.split("\n").filter((l) => /^FAIL|rror/.test(l)).slice(0, 10).join("\n")); }
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
