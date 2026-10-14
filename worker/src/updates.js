// صف update های webhook: هر update_id فقط یک بار موفق پردازش می‌شه، و شکست‌ها گم نمی‌شن.
// حالت‌ها: processing (در حال پردازش) · done (موفق) · failed (شکست؛ یک تلاش خودکار مجدد) · needs_review (نیاز به بررسی مالک)
// هر تلاش یک lease (شناسه‌ی یکتا) می‌گیره؛ فقط صاحب lease فعلی می‌تونه وضعیت رو تغییر بده.
import { tg } from "./telegram.js";
import { redact } from "./monitor.js";

export const MAX_AUTO_ATTEMPTS = 2; // یک تلاش + یک تلاش خودکار مجدد؛ بعدش needs_review
const STALE_PROCESSING_S = 90;
const KEEP_DONE_S = 7 * 86400;

const nowS = () => Math.floor(Date.now() / 1000);
const newLease = () => crypto.randomUUID();

// نوع update برای گزارش به مالک (بدون متن کاربر)
export function updateKind(update) {
  if (!update) return "نامشخص";
  if (update.callback_query) return "دکمه (callback)";
  if (update.channel_post) return "پست کانال";
  if (update.message) return "پیام";
  return "سایر";
}

// تلاش برای گرفتن مالکیت یک update
// claimed: این فراخوانی مالکه (lease برمی‌گردونه) · busy: یه پردازش دیگه داره انجامش می‌ده (تلاش مصرف نمی‌شه)
// skip: قبلاً موفق یا برای مالک نگه‌داشته شده · exhausted: سهمیه‌ی خودکار تموم شده، باید needs_review بشه
export async function claimUpdate(env, id, payloadText) {
  const now = nowS();
  await env.DB.prepare("DELETE FROM update_queue WHERE state = 'done' AND at_utc < ?").bind(now - KEEP_DONE_S).run();
  const lease = newLease();
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO update_queue (update_id, state, attempts, lease, payload, at_utc) VALUES (?, 'processing', 1, ?, ?, ?)"
  ).bind(id, lease, payloadText, now).run();
  if (ins.meta.changes === 1) return { status: "claimed", lease, attempts: 1 };

  const row = await env.DB.prepare("SELECT state, attempts, at_utc FROM update_queue WHERE update_id = ?").bind(id).first();
  if (!row) return { status: "busy" };
  if (row.state === "done" || row.state === "needs_review") return { status: "skip" };
  if (row.state === "processing" && now - row.at_utc < STALE_PROCESSING_S) return { status: "busy" };
  if (row.attempts >= MAX_AUTO_ATTEMPTS) {
    // سهمیه تموم شده: همین‌جا needs_review می‌شه و lease عوض می‌شه تا اجرای قدیمی دیگه چیزی ننویسه
    const ex = await env.DB.prepare(
      "UPDATE update_queue SET state = 'needs_review', lease = ?, at_utc = ? WHERE update_id = ? AND state = ? AND attempts = ?"
    ).bind(newLease(), now, id, row.state, row.attempts).run();
    return ex.meta.changes === 1 ? { status: "exhausted", attempts: row.attempts } : { status: "busy" };
  }

  // بازپردازش (failed یا processing منقضی): شرطی؛ اگه هم‌زمان کسی دیگه گرفته باشه، busy
  const upd = await env.DB.prepare(
    "UPDATE update_queue SET state = 'processing', attempts = attempts + 1, lease = ?, at_utc = ? WHERE update_id = ? AND state = ? AND attempts = ?"
  ).bind(lease, now, id, row.state, row.attempts).run();
  if (upd.meta.changes === 1) return { status: "claimed", lease, attempts: row.attempts + 1 };
  return { status: "busy" };
}

// ثبت نتیجه فقط توسط صاحب lease. اگه lease عوض شده (اجرای قدیمی که دیر تموم شده)، چیزی نمی‌نویسه.
export async function markOutcome(env, id, lease, outcome, errorText = "", payloadText = null) {
  const now = nowS();
  let res;
  if (outcome === "done") {
    res = await env.DB.prepare(
      "UPDATE update_queue SET state = 'done', payload = NULL, last_error = '', at_utc = ? WHERE update_id = ? AND lease = ?"
    ).bind(now, id, lease).run();
  } else {
    res = await env.DB.prepare(
      "UPDATE update_queue SET state = ?, payload = COALESCE(?, payload), last_error = ?, at_utc = ? WHERE update_id = ? AND lease = ?"
    ).bind(outcome, payloadText, redact(env, String(errorText)).slice(0, 300), now, id, lease).run();
  }
  if (res.meta.changes !== 1) {
    console.error("lease_lost", id, outcome);
    return false;
  }
  return true;
}

// وقتی کار به needs_review می‌رسه، مالک خصوصی خبر می‌گیره (بدون متن کاربر)
export async function notifyNeedsReview(env, id, update, errorText) {
  const text = [
    "⚠️ یک درخواست تلگرام نیاز به بررسی دارد",
    `شناسه: ${id}`,
    `نوع: ${updateKind(update)}`,
    `خطا: ${redact(env, errorText).slice(0, 200) || "نامشخص"}`,
    "",
    `برای تلاش دوباره (بعد از بررسی): /retry_update ${id}`,
  ].join("\n");
  try {
    await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text, disable_web_page_preview: true });
  } catch (err) {
    console.error("notify_owner_failed", id);
  }
}

// بازپردازش دستی توسط مالک: فقط برای failed یا needs_review با payload
export async function retryUpdate(env, id, dispatch) {
  const row = await env.DB.prepare("SELECT state, attempts, payload FROM update_queue WHERE update_id = ?").bind(id).first();
  if (!row) return "این شناسه پیدا نشد.";
  if (row.state !== "needs_review" && row.state !== "failed") return `این درخواست در وضعیت «${row.state}» است؛ فقط درخواست‌های نیازمند بررسی قابل تلاش مجدد هستن.`;
  if (!row.payload) return "متن درخواست دیگه ذخیره نشده؛ قابل تلاش مجدد نیست.";
  const lease = newLease();
  const upd = await env.DB.prepare(
    "UPDATE update_queue SET state = 'processing', attempts = attempts + 1, lease = ?, at_utc = ? WHERE update_id = ? AND state = ? AND attempts = ?"
  ).bind(lease, nowS(), id, row.state, row.attempts).run();
  if (upd.meta.changes !== 1) return "این درخواست هم‌زمان تغییر کرده؛ دوباره وضعیت را بررسی کن.";
  try {
    await dispatch(env, JSON.parse(row.payload));
  } catch (err) {
    await markOutcome(env, id, lease, "needs_review", err && err.message ? err.message : "unknown");
    return "تلاش مجدد هم شکست خورد؛ درخواست در وضعیت نیازمند بررسی باقی موند.";
  }
  await markOutcome(env, id, lease, "done");
  return "تلاش مجدد انجام شد.";
}
