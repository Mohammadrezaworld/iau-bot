// اجرای زمان‌بندی‌شده‌ی اسکرپ‌ها از داخل Worker (به‌جای زمان‌بند GitHub که نامنظمه).
// کرون دقیقه‌ای موجود (* * * * *) هر دقیقه صدا زده می‌شه؛ اینجا فقط در دقیقه‌های مشخص کاری انجام می‌ده:
//   بله:     هر ۳۰ دقیقه (دقیقه‌ی ۰ و ۳۰ UTC)
//   تلگرام:  هر ۲ ساعت (دقیقه‌ی ۱۰ UTC، ساعت‌های زوج بین ۰۴ تا ۲۲)
// ساعت سکوت (به وقت تهران، پیش‌فرض ۰۲ تا ۰۶) رعایت می‌شه.
import { inTehranQuietHours } from "./channels.js";

export const BALE_WORKFLOW = "scrape-bale.yml";
export const TELEGRAM_WORKFLOW = "scrape-telegram.yml";

function jobsForMinute(now) {
  const min = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const jobs = [];
  if (min === 0 || min === 30) jobs.push(BALE_WORKFLOW);
  if (min === 10 && hour % 2 === 0 && hour >= 4 && hour <= 22) jobs.push(TELEGRAM_WORKFLOW);
  return jobs;
}

async function saveSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

// یک workflow_dispatch به GitHub می‌فرسته. توکن فقط در هدر Authorization می‌ره و هیچ‌وقت لاگ یا پیام نمی‌شه.
export async function dispatchWorkflow(env, wf) {
  if (!env.GH_DISPATCH_TOKEN || !env.GH_REPO) return { ok: false, reason: "not_configured" };
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${wf}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "iaut-bot",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) return { ok: false, reason: `http_${res.status}` };
  await saveSetting(env, `last_dispatch_${wf}`, String(Math.floor(Date.now() / 1000)));
  return { ok: true };
}

// از کرون دقیقه‌ای صدا زده می‌شه. اگه کاری نباشه، هیچ کوئری به D1 زده نمی‌شه.
export async function scheduledDispatch(env, now = new Date()) {
  const jobs = jobsForMinute(now);
  if (!jobs.length) return;
  if (await inTehranQuietHours(env, now.getTime())) return;
  for (const wf of jobs) {
    try {
      const r = await dispatchWorkflow(env, wf);
      if (!r.ok) console.error("dispatch_failed", wf, r.reason);
    } catch (err) {
      console.error("dispatch_error", wf, err && err.message ? err.message : "unknown");
    }
  }
}

// برای نمایش در /status: زمان آخرین اجرای موفق هر workflow (به وقت تهران)
export async function lastDispatchLines(env) {
  const fmt = (ts) =>
    ts
      ? new Date(Number(ts) * 1000).toLocaleString("fa-IR", { timeZone: "Asia/Tehran", hour12: false })
      : "هنوز نه";
  const rows = (await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN (?, ?)"
  ).bind(`last_dispatch_${BALE_WORKFLOW}`, `last_dispatch_${TELEGRAM_WORKFLOW}`).all()).results;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return [
    `- بله: ${fmt(map[`last_dispatch_${BALE_WORKFLOW}`])}`,
    `- تلگرام: ${fmt(map[`last_dispatch_${TELEGRAM_WORKFLOW}`])}`,
  ];
}
