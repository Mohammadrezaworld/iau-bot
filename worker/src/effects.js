// ثبت اثرهای بیرونی و داخلی هر update (جدول effects).
// تضمین‌ها (نه exactly-once):
// - DB (contacts/resources/events): درج ردیف و ثبت effect در یک batch (تراکنش D1) با کلید پایدار.
//   اگه effect با همان کلید done باشه، ردیف دوباره درج نمی‌شه. شناسه‌ی ردیف (row_id) ثبت می‌شه.
// - ارسال بیرونی (copyMessage جزوه): پیش از تماس با تلگرام، با lease همین اجرا claim می‌شه (state=intent).
//   یعنی هر کلید حداکثر یک تلاش خودکار دارد. اگه نتیجه‌ی ارسال نامشخص بمونه (شبکه، پاسخ ناخوانا، یا ثبت نتیجه شکست بخوره)،
//   intent می‌مونه و update به needs_review (ambiguous) می‌ره. تلاش دوباره فقط با تصمیم مالک (/resolve_update) ممکنه.
//   تلگرام ارسال تکراری را جلوگیری نمی‌کنه؛ اگه پیام واقعاً رسیده باشه ولی ما ندونیم، فقط مالک می‌تونه تصمیم بگیره.
// حالت‌ها: intent (در حال انجام / نامشخص) · done (انجام شد؛ msg_id ذخیره شده) · failed (تلگرام صریحاً رد کرده؛ تلاش مجدد مجازه)

export const EFFECT_STALE_S = 90;

// اجرایی که ادامه‌اش ممکنه اثر بیرونی تازه بسازه ولی دیگه مالک نیست
export class LeaseLostError extends Error {
  constructor() { super("lease_lost"); this.name = "LeaseLostError"; }
}
// نتیجه‌ی یک اثر نامشخصه؛ update باید needs_review بشه و بدون بررسی مالک تکرار نشه
export class AmbiguousError extends Error {
  constructor(opKey) { super(`ambiguous_effect ${opKey}`); this.name = "AmbiguousError"; this.opKey = opKey; }
}

const nowS = () => Math.floor(Date.now() / 1000);

// درج ردیف + ثبت effect در یک batch. اگه کلید قبلاً done باشه، هیچ ردیفی اضافه نمی‌شه.
// stmt: { table, cols: [..], vals: [..] }  ·  result: خلاصه‌ی قابل بازیابی
// خروجی: { created: boolean }
export async function dbEffect(env, opKey, kind, stmt, result) {
  if (!opKey) throw new Error("dbEffect: opKey لازم است");
  const cols = stmt.cols.join(", ");
  const marks = stmt.cols.map(() => "?").join(", ");
  const res = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO effects (op_key, kind, state, update_id, lease, result, at_utc) VALUES (?, ?, 'intent', NULL, '', '', ?)")
      .bind(opKey, kind, nowS()),
    env.DB.prepare(`INSERT INTO ${stmt.table} (${cols}) SELECT ${marks} WHERE EXISTS (SELECT 1 FROM effects WHERE op_key = ? AND state = 'intent')`)
      .bind(...stmt.vals, opKey),
    // last_insert_rowid فقط وقتی این batch ردیف را درج کرده (state=intent) معتبره
    env.DB.prepare("UPDATE effects SET state = 'done', result = ?, row_id = last_insert_rowid() WHERE op_key = ? AND state = 'intent'")
      .bind(String(result).slice(0, 500), opKey),
  ]);
  const created = res[2].meta.changes === 1;
  let rowId = null;
  if (created) {
    const r = await env.DB.prepare("SELECT row_id FROM effects WHERE op_key = ?").bind(opKey).first();
    rowId = r ? r.row_id : null;
  }
  return { created, rowId };
}

// ادعای ارسال بیرونی با lease اجرا. فقط اگه lease هنوز مال همین اجراست.
// خروجی: claimed | done(msgId) | busy | ambiguous | lease_lost
export async function claimExternal(env, ctx, opKey, kind) {
  if (!ctx || !ctx.updateId || !ctx.lease) return { status: "lease_lost" };
  const now = nowS();
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO effects (op_key, kind, state, update_id, lease, at_utc) SELECT ?, ?, 'intent', update_id, lease, ? FROM update_queue WHERE update_id = ? AND lease = ? AND state = 'processing'"
  ).bind(opKey, kind, now, ctx.updateId, ctx.lease).run();
  if (ins.meta.changes === 1) return { status: "claimed" };

  const own = await env.DB.prepare("SELECT 1 AS ok FROM update_queue WHERE update_id = ? AND lease = ? AND state = 'processing'")
    .bind(ctx.updateId, ctx.lease).first();
  if (!own) return { status: "lease_lost" };

  const row = await env.DB.prepare("SELECT state, msg_id, at_utc FROM effects WHERE op_key = ?").bind(opKey).first();
  if (!row) return { status: "busy" };
  if (row.state === "done") return { status: "done", msgId: row.msg_id };
  if (row.state === "failed") {
    // تلگرام صریحاً رد کرده بود؛ تلاش مجدد مجازه (شرطی، تا دو اجرا هم‌زمان هم‌زمان claim نکنن)
    const up = await env.DB.prepare(
      "UPDATE effects SET state = 'intent', update_id = ?, lease = ?, at_utc = ?, last_error = '' WHERE op_key = ? AND state = 'failed'"
    ).bind(ctx.updateId, ctx.lease, now, opKey).run();
    return up.meta.changes === 1 ? { status: "claimed" } : { status: "busy" };
  }
  // intent: اگه تازه‌ست، یه اجرای دیگه داره انجامش می‌ده؛ اگه کهنه‌ست، نتیجه‌ش نامشخصه
  if (now - row.at_utc < EFFECT_STALE_S) return { status: "busy" };
  return { status: "ambiguous" };
}

// ثبت نتیجه‌ی ارسال. اگه این نوشتن هم شکست بخوره، intent می‌مونه و بعداً نامشخص دیده می‌شه (گم نمی‌شه).
export async function finishExternal(env, ctx, opKey, outcome) {
  if (outcome.ok) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await env.DB.prepare(
          "UPDATE effects SET state = 'done', msg_id = ?, result = ?, last_error = '' WHERE op_key = ? AND lease = ? AND state = 'intent'"
        ).bind(outcome.msgId ?? null, String(outcome.result || "").slice(0, 300), opKey, ctx.lease).run();
        if (r.meta.changes === 1) return true;
        console.error("effect_finish_unexpected", opKey);
        return false;
      } catch (err) {
        console.error("effect_finish_retry", opKey);
      }
    }
    return false;
  }
  // refused: اثری نبوده
  await env.DB.prepare("UPDATE effects SET state = 'failed', last_error = ? WHERE op_key = ? AND lease = ? AND state = 'intent'")
    .bind(String(outcome.error || "refused").slice(0, 300), opKey, ctx.lease).run();
  return true;
}
