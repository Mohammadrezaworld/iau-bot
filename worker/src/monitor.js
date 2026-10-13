// پایش اسکرپ‌ها: ثبت خطاها و رویدادها، هشدار به مالک، سلامت منابع و گزارش روزانه.
// این ماژول هیچ‌وقت به گروه یا کانال پیام نمی‌فرسته؛ فقط DM مالک.
import { sendMessage } from "./telegram.js";
import { getSetting } from "./public.js";
import { inTehranQuietHours } from "./channels.js";
import { faNum } from "./calendar.js";

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const LABEL = { bale: "بله", telegram: "تلگرام", system: "سیستم" };
const KIND_FA = { error: "خطا", health: "سلامت", delivered: "ارسال به گروه" };
// حداکثر فاصله‌ی مجاز بین دو اجرای موفق، بیرون از ساعت سکوت (دقیقه)
// تلگرام: زمان‌بندی GitHub گاهی تأخیر چند ساعته داره، پس آستانه بزرگ‌تره
export const HEALTH_LIMIT_MIN = { bale: 90, telegram: 480 };
const ALERT_GAP_S = 60 * 60; // هشدار خطا برای هر منبع حداکثر یک بار در ساعت
const RETENTION_S = 30 * 24 * 60 * 60;

const nowUtc = () => Math.floor(Date.now() / 1000);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// ساعت و تاریخ تهران (تهران UTC+3:30 و بدون ساعت تابستانی)
const TEHRAN_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tehran",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function tehranParts(ms) {
  const parts = Object.fromEntries(TEHRAN_FMT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function fmtTehran(ms) {
  return new Date(ms).toLocaleString("fa-IR", {
    timeZone: "Asia/Tehran",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// حذف رمز و کلیدهای احتمالی از متن، کوتاه‌کردن. قبل از ثبت یا ارسال همیشه اجرا می‌شه.
export function redact(env, text) {
  let out = String(text || "");
  for (const secret of [env.INGEST_SECRET, env.TELEGRAM_BOT_TOKEN]) {
    if (secret) out = out.split(String(secret)).join("[redacted]");
  }
  return out
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, String(value)).run();
}

async function alertOwner(env, text) {
  try {
    await sendMessage(env, env.OWNER_ID, text);
  } catch (err) {
    console.error("alert_error", redact(env, err && err.message ? err.message : "unknown"));
  }
}

// ثبت یک رویداد. هیچ‌وقت exception نمی‌ندازه تا منطق اصلی (ingest، cron) خراب نشه.
export async function recordEvent(env, source, channel, kind, detail = "") {
  try {
    await env.DB.prepare(
      "INSERT INTO scrape_events (at_utc, source, channel, kind, detail) VALUES (?, ?, ?, ?, ?)"
    ).bind(nowUtc(), String(source), String(channel || "").slice(0, 100), kind, redact(env, detail)).run();
  } catch (err) {
    console.error("event_log_error", redact(env, err && err.message ? err.message : "unknown"));
  }
}

// گزارش خطا: ثبت در scrape_events و در صورت گذشت ۶۰ دقیقه از هشدار قبلی همین منبع+کانال، DM به مالک.
// هیچ‌وقت exception نمی‌ندازه. برمی‌گردونه true اگه هشدار فرستاده شد.
export async function reportError(env, source, channel, stage, message) {
  try {
    const src = ["bale", "telegram"].includes(source) ? source : "system";
    const stg = String(stage || "unknown").replace(/[^a-z_]/gi, "").slice(0, 30) || "unknown";
    const text = redact(env, message);
    await recordEvent(env, src, channel, "error", `${stg}: ${text}`);

    // محدودیت هشدار برای هر منبع+کانال جداست تا خطای یک کانال، خطای کانال دیگه رو پنهان نکنه
    const alertKey = `alert_at:${src}:${channel || "-"}`;
    const nowS = nowUtc();
    const last = Number(await getSetting(env, alertKey, "0")) || 0;
    if (nowS - last < ALERT_GAP_S) return false;
    await setSetting(env, alertKey, nowS);
    const where = channel ? ` · ${channel}` : "";
    await alertOwner(env, `❌ خطا در اسکرپ ${LABEL[src]}${where}\nمرحله: ${stg}\n${text}`);
    return true;
  } catch (err) {
    console.error("report_error_failed", redact(env, err && err.message ? err.message : "unknown"));
    return false;
  }
}

// POST /scrape-report: فقط با رمز ingest. GitHub Actions و اسکریپت‌ها خطا رو اینجا می‌فرستن.
export async function handleScrapeReport(request, env) {
  if (request.headers.get("x-ingest-secret") !== env.INGEST_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_request" }, 400);
  const alerted = await reportError(
    env,
    body.source,
    String(body.channel || ""),
    body.stage,
    String(body.message || "").slice(0, 1000)
  );
  return json({ ok: true, alerted });
}

// آخرین لحظه‌ی پایان ساعت سکوت (ساعت کامل تهران) قبل از now
async function lastQuietEnd(env, now) {
  const raw = await getSetting(env, "quiet", "2-6");
  const end = Number(String(raw).split("-")[1]);
  const endHour = Number.isInteger(end) && end >= 0 && end <= 23 ? end : 6;
  // مرزهای ساعت کامل تهران هر ۳۰ دقیقه‌ی UTC هستن
  let t = Math.floor((now - 30 * MIN_MS) / HOUR_MS) * HOUR_MS + 30 * MIN_MS;
  for (let k = 0; k < 25; k++, t -= HOUR_MS) {
    if (tehranParts(t).hour === endHour) return t;
  }
  return null;
}

// وضعیت یک منبع. مبنا = بیشترین مقدار از آخرین اجرای موفق و آخرین پایان ساعت سکوت،
// تا فاصله‌ی شبانه‌ی سکوت هشدار اشتباه نده. در ساعت سکوت هیچ‌وقت متوقف حساب نمی‌شه.
export async function sourceStatus(env, source, now = Date.now()) {
  const row = await env.DB.prepare(
    "SELECT MAX(ran_at_utc) AS t FROM scrape_runs WHERE source = ? AND ok = 1"
  ).bind(source).first();
  const last = row && row.t ? row.t * 1000 : null;
  if (last === null) return { last: null, stale: false };
  if (await inTehranQuietHours(env, now)) return { last, stale: false };
  const quietEnd = await lastQuietEnd(env, now);
  const baseline = Math.max(last, quietEnd === null ? last : quietEnd);
  const stale = now - baseline > HEALTH_LIMIT_MIN[source] * MIN_MS;
  return { last, stale };
}

// هر ۵ دقیقه (زمان UTC): اگه وضعیت منبعی عوض شده، یک بار به مالک خبر بده
export async function checkScrapeHealth(env, now = Date.now()) {
  if (Math.floor(now / MIN_MS) % 5 !== 0) return;
  if (await inTehranQuietHours(env, now)) return;
  for (const source of Object.keys(HEALTH_LIMIT_MIN)) {
    const st = await sourceStatus(env, source, now);
    if (st.last === null) continue;
    const state = st.stale ? "down" : "ok";
    const key = `health_${source}`;
    const prev = await getSetting(env, key, "ok");
    if (state === prev) continue;
    await setSetting(env, key, state);
    await recordEvent(env, source, "", "health", state);
    await alertOwner(
      env,
      state === "down"
        ? `⚠️ اسکرپ ${LABEL[source]} متوقف به نظر می‌رسه.\nآخرین اجرای موفق: ${fmtTehran(st.last)}`
        : `✅ اسکرپ ${LABEL[source]} دوباره برقرار شد.`
    );
  }
}

// خطوط وضعیت سلامت برای /status
export async function healthLines(env, now = Date.now()) {
  const out = [];
  for (const source of Object.keys(HEALTH_LIMIT_MIN)) {
    const st = await sourceStatus(env, source, now);
    out.push(
      st.last === null
        ? `${LABEL[source]}: هنوز اجرایی ثبت نشده`
        : `${LABEL[source]}: ${st.stale ? "⚠️ متوقف" : "✅ سالم"} (آخرین موفق: ${fmtTehran(st.last)})`
    );
  }
  return out;
}

// گزارش روزانه به مالک، ساعت ۰۸:۰۰ تهران، فقط یک بار در روز
export async function sendDailySummary(env, now = Date.now()) {
  const p = tehranParts(now);
  if (p.hour !== 8 || p.minute >= 10) return;
  if ((await getSetting(env, "summary_sent_on", "")) === p.date) return;

  const since = Math.floor(now / 1000) - 24 * 60 * 60;
  const { results: runs } = await env.DB.prepare(
    "SELECT source, COUNT(*) AS n, COALESCE(SUM(new_count), 0) AS fresh FROM scrape_runs WHERE ran_at_utc >= ? GROUP BY source"
  ).bind(since).all();
  const { results: errs } = await env.DB.prepare(
    "SELECT source, COUNT(*) AS n FROM scrape_events WHERE kind = 'error' AND at_utc >= ? GROUP BY source"
  ).bind(since).all();
  const delivered = await env.DB.prepare(
    "SELECT COALESCE(SUM(CAST(detail AS INTEGER)), 0) AS n FROM scrape_events WHERE kind = 'delivered' AND at_utc >= ?"
  ).bind(since).first();
  const unsent = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").first();

  const lines = ["📊 گزارش ۲۴ ساعت گذشته‌ی اسکرپ"];
  for (const source of Object.keys(HEALTH_LIMIT_MIN)) {
    const r = runs.find((x) => x.source === source) || { n: 0, fresh: 0 };
    const e = errs.find((x) => x.source === source);
    lines.push(`• ${LABEL[source]}: ${faNum(r.n)} بررسی · ${faNum(r.fresh)} پست جدید · ${faNum(e ? e.n : 0)} خطا`);
  }
  lines.push(`• ارسال به گروه: ${faNum(delivered.n)} پست`);
  lines.push(`• پست‌های در صف ارسال: ${faNum(unsent.n)}`);
  lines.push(...(await healthLines(env, now)));

  await sendMessage(env, env.OWNER_ID, lines.join("\n"));
  await setSetting(env, "summary_sent_on", p.date);
  await env.DB.prepare("DELETE FROM scrape_events WHERE at_utc < ?")
    .bind(Math.floor(now / 1000) - RETENTION_S).run();
}

// /scrape_log: ۲۰ رویداد آخر
export async function scrapeLogText(env) {
  const { results } = await env.DB.prepare(
    "SELECT at_utc, source, channel, kind, detail FROM scrape_events ORDER BY id DESC LIMIT 20"
  ).all();
  if (!results.length) return "هنوز رویدادی ثبت نشده.";
  return results
    .map((r) => {
      const src = LABEL[r.source] || r.source;
      const where = r.channel ? `${src} / ${r.channel}` : src;
      let detail = r.detail;
      if (r.kind === "health") detail = r.detail === "down" ? "متوقف به نظر می‌رسه" : "برقرار شد";
      if (r.kind === "delivered") detail = `${faNum(Number(r.detail))} پست`;
      return `${fmtTehran(r.at_utc * 1000)} | ${where} | ${KIND_FA[r.kind] || r.kind}${detail ? " | " + detail : ""}`;
    })
    .join("\n");
}
