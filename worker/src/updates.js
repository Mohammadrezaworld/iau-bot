// صف update های webhook (جدول update_queue). تضمین: حداکثر یک تلاش خودکار برای هر update؛ نتیجه‌ی مبهم به مالک می‌رسه (exactly-once نیست).
// حالت‌ها: processing · done · failed (شکست؛ تلاش خودکار مجدد مجاز) · needs_review (نیاز به تصمیم مالک)
// reason: error | exhausted | ambiguous (اثر نامشخص) | done_write (انجام شد ولی ثبت پایان نشد) | migrated | owner_applied | owner_not_applied
// هر تلاش یک lease می‌گیره؛ فقط صاحب lease فعلی می‌تونه وضعیت رو تغییر بده.
import { tg } from "./telegram.js";
import { redact } from "./monitor.js";
import { AmbiguousError, LeaseLostError } from "./effects.js";

export const MAX_AUTO_ATTEMPTS = 2; // یک تلاش + یک تلاش خودکار مجدد
const STALE_PROCESSING_S = 90;      // lease قدیمی: قابل claim مجدد
const STUCK_PROCESSING_S = 600;     // processing خیلی قدیمی: در فهرست بررسی نشون داده می‌شه
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

// claimed: مالک این اجراست (lease) · busy: اجرای دیگه‌ای فعاله (تلاش مصرف نمی‌شه)
// skip: قبلاً موفق یا نیازمند تصمیم مالک · exhausted: سهمیه‌ی خودکار تموم شده؛ همین‌جا needs_review شد
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
    const ex = await env.DB.prepare(
      "UPDATE update_queue SET state = 'needs_review', reason = 'exhausted', lease = ?, at_utc = ? WHERE update_id = ? AND state = ? AND attempts = ?"
    ).bind(newLease(), now, id, row.state, row.attempts).run();
    return ex.meta.changes === 1 ? { status: "exhausted", attempts: row.attempts } : { status: "busy" };
  }

  const upd = await env.DB.prepare(
    "UPDATE update_queue SET state = 'processing', attempts = attempts + 1, lease = ?, at_utc = ? WHERE update_id = ? AND state = ? AND attempts = ?"
  ).bind(lease, now, id, row.state, row.attempts).run();
  if (upd.meta.changes === 1) return { status: "claimed", lease, attempts: row.attempts + 1 };
  return { status: "busy" };
}

// ثبت نتیجه فقط توسط صاحب lease. اگه lease عوض شده، false برمی‌گردونه و چیزی نمی‌نویسه.
export async function markOutcome(env, id, lease, outcome, errorText = "", reason = "") {
  const now = nowS();
  const safeErr = redact(env, String(errorText)).slice(0, 300);
  const res = outcome === "done"
    ? await env.DB.prepare("UPDATE update_queue SET state = 'done', payload = NULL, last_error = '', reason = '', at_utc = ? WHERE update_id = ? AND lease = ?").bind(now, id, lease).run()
    : await env.DB.prepare("UPDATE update_queue SET state = ?, last_error = ?, reason = ?, at_utc = ? WHERE update_id = ? AND lease = ?")
        .bind(outcome, safeErr, reason, now, id, lease).run();
  if (res.meta.changes !== 1) {
    console.error("lease_lost", id, outcome);
    return false;
  }
  return true;
}

// ثبت done با دو تلاش؛ اگه باز هم شکست بخوره، ردیف processing می‌مونه و در فهرست مالک با reason=done_write دیده می‌شه
export async function markDoneWithRetry(env, id, lease) {
  for (let i = 0; i < 2; i++) {
    try {
      return await markOutcome(env, id, lease, "done");
    } catch (err) {
      console.error("mark_done_failed", id);
    }
  }
  return false;
}

// اطلاع خصوصی به مالک (بدون متن کاربر). اگه ارسال نشه، notify_state=failed می‌مونه و در فهرست دیده می‌شه.
export async function notifyNeedsReview(env, id, update, errorText, reason) {
  const text = [
    "⚠️ یک درخواست تلگرام نیاز به بررسی دارد",
    `شناسه: ${id}`,
    `نوع: ${updateKind(update)}`,
    `علت: ${reason || "خطا"}`,
    `خطا: ${redact(env, errorText).slice(0, 200) || "نامشخص"}`,
    "",
    "فهرست موارد: /review",
  ].join("\n");
  let sent = false;
  try {
    await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text, disable_web_page_preview: true });
    sent = true;
  } catch (err) {
    console.error("notify_owner_failed", id);
  }
  try {
    await env.DB.prepare("UPDATE update_queue SET notify_state = ? WHERE update_id = ?").bind(sent ? "sent" : "failed", id).run();
  } catch (err) {
    console.error("notify_state_write_failed", id);
  }
  return sent;
}

// آیا برای این update اثر نامشخص (intent) مونده؟ اگه بله، retry بدون تصمیم مالک مجاز نیست
async function hasUnknownEffects(env, id) {
  const r = await env.DB.prepare("SELECT 1 AS x FROM effects WHERE update_id = ? AND state = 'intent' LIMIT 1").bind(id).first();
  return !!r;
}

// فهرست موارد نیازمند بررسی برای مالک
export async function listReview(env) {
  const now = nowS();
  const { results } = await env.DB.prepare(
    `SELECT update_id, state, reason, attempts, notify_state, last_error, at_utc, payload
     FROM update_queue
     WHERE state = 'needs_review'
        OR (state = 'processing' AND at_utc < ?)
        OR (state = 'failed' AND at_utc < ?)
        OR notify_state = 'failed'
     ORDER BY at_utc DESC LIMIT 10`
  ).bind(now - STUCK_PROCESSING_S, now - STUCK_PROCESSING_S).all();
  const out = [];
  for (const r of results) {
    const effects = await effectsFor(env, r);
    out.push({
      update_id: r.update_id, state: r.state, reason: r.reason, notify_state: r.notify_state,
      last_error: r.last_error, has_payload: r.payload != null,
      unknown: effects.some((e) => e.state === "intent"), effects,
    });
  }
  return out;
}

// اثرهای این update برای بررسی دستی: شناسه‌ی ردیف DB یا شناسه‌ی پیام Telegram (اگه ثبت شده)
// اثرهای DB با کلید پیام (msg:chat:message_id:…) پیدا می‌شن؛ متن update هیچ‌وقت نمایش داده نمی‌شه
async function effectsFor(env, row) {
  let prefix = null;
  if (row.payload) {
    try {
      const u = JSON.parse(row.payload);
      if (u.message && u.message.chat) prefix = `msg:${u.message.chat.id}:${u.message.message_id}:%`;
    } catch (err) { /* payload خراب: فقط اثرهای با update_id */ }
  }
  const { results } = await env.DB.prepare(
    "SELECT op_key, kind, state, row_id, msg_id FROM effects WHERE update_id = ? OR (? IS NOT NULL AND op_key LIKE ?) ORDER BY at_utc DESC LIMIT 5"
  ).bind(row.update_id, prefix, prefix || "").all();
  return results;
}

// شناسه‌ی update: تلگرام مثبت می‌دهد؛ ارسال خودکار شناسه‌ی منفی و غیرصفر دارد. هر دو باید در صف ثبت باشند (بررسی وجود در retry/resolve).
export const isUpdateId = (id) => Number.isSafeInteger(id) && id !== 0;

export function describeReviewRow(r) {
  const state = r.state === "processing" ? "پردازش مانده (نتیجه نامشخص)" : r.state === "failed" ? "شکست خورده" : "نیازمند بررسی";
  const parts = [`#${r.update_id} · ${state}`];
  if (r.reason) parts.push(`علت: ${r.reason}`);
  if (r.unknown) parts.push("اثر نامشخص دارد؛ اول /resolve_update");
  if (r.notify_state === "failed") parts.push("اطلاع خودکار نرسید");
  if (!r.has_payload) parts.push("متن ذخیره نیست (فقط بستن ممکن است)");
  if (r.last_error) parts.push(`خطا: ${String(r.last_error).slice(0, 120)}`);
  for (const e of r.effects || []) {
    const ref = [e.row_id != null ? `ردیف DB #${e.row_id}` : "", e.msg_id != null ? `پیام تلگرام #${e.msg_id}` : ""].filter(Boolean).join("، ") || "شناسه ثبت نشده";
    parts.push(`• ${e.kind} · ${e.state} · ${ref} · کلید ${e.op_key}`);
  }
  return parts.join("\n");
}

// بازپردازش توسط مالک. فقط وقتی اثر نامشخصی نمونده و متن موجوده.
// اثرهای قبلاً done با کلید پایدار دوباره اجرا نمی‌شن؛ پس retry امنه.
export async function retryUpdate(env, id, dispatch) {
  const row = await env.DB.prepare("SELECT state, attempts, payload, at_utc FROM update_queue WHERE update_id = ?").bind(id).first();
  if (!row) return "این شناسه پیدا نشد.";
  const okState = row.state === "failed" || row.state === "needs_review" ||
    (row.state === "processing" && nowS() - row.at_utc > STUCK_PROCESSING_S);
  if (!okState) return `این درخواست در وضعیت «${row.state}» است؛ تلاش مجدد ممکن نیست.`;
  if (!row.payload) return "متن این درخواست ذخیره نشده؛ فقط می‌شه با /resolve_update بستش.";
  if (await hasUnknownEffects(env, id)) return "این درخواست اثر نامشخص دارد؛ اول با /resolve_update applied یا not_applied تصمیم بگیر.";

  const lease = newLease();
  const upd = await env.DB.prepare(
    `UPDATE update_queue SET state = 'processing', attempts = attempts + 1, lease = ?, at_utc = ?, reason = ''
     WHERE update_id = ? AND state = ? AND attempts = ?
       AND NOT EXISTS (SELECT 1 FROM effects WHERE update_id = ? AND state = 'intent')`
  ).bind(lease, nowS(), id, row.state, row.attempts, id).run();
  if (upd.meta.changes !== 1) return "این درخواست هم‌زمان تغییر کرده؛ دوباره /review را ببین.";

  let out;
  const payload = JSON.parse(row.payload);
  try {
    out = await dispatch(env, payload, { updateId: id, lease });
  } catch (err) {
    if (err instanceof LeaseLostError) return "اجرای دیگری این درخواست را گرفته؛ چیزی تغییر نکرد.";
    const amb = err instanceof AmbiguousError;
    await markOutcome(env, id, lease, "needs_review", err && err.message ? err.message : "unknown", amb ? "ambiguous" : "error");
    if (amb) await notifyNeedsReview(env, id, null, err.message, "ambiguous");
    return amb ? "اثری نامشخص ماند؛ قبل از تلاش دوباره /resolve_update را بزن." : "تلاش مجدد هم شکست خورد؛ در فهرست باقی موند.";
  }
  if (!(await markDoneWithRetry(env, id, lease))) return "کار انجام شد، ولی ثبت پایان نشد؛ در /review دیده می‌شه.";
  // دسته‌ی خودکار: متن واقعی نتیجه (مثلاً «حالت تغییر کرد؛ باقی‌مانده نگه داشته شد») به مالک نشان داده شود
  if (payload && payload.kind === "auto_batch" && typeof out === "string" && out) return out;
  return "تلاش مجدد انجام شد.";
}

// تصمیم مالک درباره‌ی اثر نامشخص: applied → done (بدون تکرار) · not_applied → اثر failed و retry مجاز
export async function resolveUpdate(env, id, decision) {
  const row = await env.DB.prepare("SELECT state, at_utc FROM update_queue WHERE update_id = ?").bind(id).first();
  if (!row) return "این شناسه پیدا نشد.";
  if (row.state === "done") return "این درخواست قبلاً انجام شده.";
  if (row.state === "processing" && nowS() - row.at_utc <= STUCK_PROCESSING_S) return "این درخواست هنوز در حال پردازشه؛ بعداً دوباره تصمیم بگیر.";
  if (decision === "applied") {
    await env.DB.prepare("UPDATE effects SET state = 'done', last_error = 'owner_applied' WHERE update_id = ? AND state = 'intent'").bind(id).run();
    await env.DB.prepare("UPDATE update_queue SET state = 'done', reason = 'owner_applied', payload = NULL, lease = '' WHERE update_id = ?").bind(id).run();
    // بخش‌های دسته‌ی اسکرپ که مالک «اعمال شد» گفته، پست‌هاشون ارسال‌شده علامت می‌خوره
    await env.DB.prepare(
      "INSERT OR IGNORE INTO post_outcomes (post_id, outcome, at_utc) SELECT bi.post_id, 'owner_applied', ? FROM scrape_batch_items bi JOIN effects e ON e.op_key = bi.unit JOIN posts p ON p.id = bi.post_id WHERE e.update_id = ? AND p.sent_at_utc IS NULL"
    ).bind(nowS(), id).run();
    await env.DB.prepare(
      "UPDATE posts SET sent_at_utc = ? WHERE sent_at_utc IS NULL AND id IN (SELECT bi.post_id FROM scrape_batch_items bi JOIN effects e ON e.op_key = bi.unit WHERE e.update_id = ?)"
    ).bind(nowS(), id).run();
    return "ثبت شد: اثر انجام شده و درخواست بسته شد.";
  }
  await env.DB.prepare("UPDATE effects SET state = 'failed', last_error = 'owner_not_applied' WHERE update_id = ? AND state = 'intent'").bind(id).run();
  await env.DB.prepare("UPDATE update_queue SET state = 'failed', reason = 'owner_not_applied', lease = '' WHERE update_id = ?").bind(id).run();
  return "ثبت شد: اثری نبوده. حالا می‌شه با /retry_update دوباره اجرا کرد.";
}
