// دسته‌ی پست‌های اسکرپ برای تأیید مالک.
// - prepareBatch: پست‌های جدید (بدون دسته) را در یک دسته می‌گذاره و پیش‌نمایش را به پیوی مالک می‌فرسته. پست جدید نباشه، دسته‌ای ساخته نمی‌شه.
// - approveBatch: با تأیید مالک، هر بخش ارسال با claim در effects فرستاده می‌شه؛ دوبار ارسال یا retry، بخش ارسال‌شده را دوباره نمی‌فرسته.
// - rejectBatch: پست‌های دسته دیگه پیشنهاد نمی‌شن.
// - expireBatches: دسته‌ی بی‌جواب بعد از مهلت منقضی می‌شه و پست‌هاش در دسته‌ی بعدی می‌آن (هیچ ارسال خودکاری نیست).
import { tg } from "./telegram.js";
import { getSetting } from "./public.js";
import { recordEvent } from "./monitor.js";
import { scrapePaused, inTehranQuietHours, keywordsList, cleanPostText, isJunkPost, buildSections, chunkMessages, sendChunk, sendPhotos } from "./channels.js";
import { claimExternal, finishExternal, AmbiguousError, LeaseLostError } from "./effects.js";

export const BATCH_TTL_S = 12 * 3600;
const CONTENT_ERROR = /too long|text is empty|parse entities|message text/i;
const nowUtc = () => Math.floor(Date.now() / 1000);
const STATE_FA = { sent: "ارسال‌شده", rejected: "ردشده", expired: "منقضی‌شده", empty: "خالی", pending: "منتظر تأیید", sending: "در حال ارسال" };

// پاک‌سازی متن بله (فوتر) مثل قبل؛ هم در پیش‌نمایش و هم در ارسال یکی است
function forSend(p) {
  return p.source === "bale" ? { ...p, text: cleanPostText(p.text) } : p;
}

// پست‌های جدید → یک دسته + پیش‌نمایش برای مالک
export async function prepareBatch(env) {
  if (await inTehranQuietHours(env)) return { skipped: "quiet_hours" };
  if (await scrapePaused(env)) return { skipped: "paused" };
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return { skipped: "no_group" };

  const { results } = await env.DB.prepare(
    `SELECT * FROM posts WHERE sent_at_utc IS NULL AND id NOT IN (SELECT post_id FROM scrape_batch_items)
     ORDER BY source, channel, first_seen_utc, id LIMIT 200`
  ).all();
  if (!results.length) return { prepared: 0 };

  // پست‌های بله که فقط فوتر/عدد هستن، بدون ارسال علامت می‌خورن
  const candidates = [];
  for (const p of results) {
    if (p.source === "bale" && isJunkPost(p.text)) {
      await env.DB.prepare("UPDATE posts SET sent_at_utc = ? WHERE id = ?").bind(nowUtc(), p.id).run();
    } else {
      candidates.push(p);
    }
  }
  if (!candidates.length) return { prepared: 0 };

  const now = nowUtc();
  const created = await env.DB.prepare("INSERT INTO scrape_batches (state, created_utc, expires_utc) VALUES ('pending', ?, ?) RETURNING id")
    .bind(now, now + BATCH_TTL_S).first();
  const bid = created.id;
  // claim اتمی: هر پست فقط با INSERT OR IGNORE (کلید post_id) به یک دسته می‌ره؛ دو اجرای هم‌زمان مجموعه‌های جدا می‌گیرن
  const res = await env.DB.batch(candidates.map((p) =>
    env.DB.prepare("INSERT OR IGNORE INTO scrape_batch_items (post_id, batch_id) VALUES (?, ?)").bind(p.id, bid)
  ));
  const claimed = candidates.filter((_, i) => res[i].meta.changes === 1);
  if (!claimed.length) {
    await env.DB.prepare("UPDATE scrape_batches SET state = 'empty' WHERE id = ?").bind(bid).run();
    return { prepared: 0 };
  }

  const keywords = await keywordsList(env);
  const sections = buildSections(claimed.map(forSend), keywords);
  try {
    await sendPreview(env, bid, sections, claimed.length);
  } catch (err) {
    // دسته ساخته شده و منتظره؛ اگه پیش‌نمایش نرسه، مالک در زمان انقضا خبر می‌گیره و پست‌ها دوباره پیشنهاد می‌شن
    await recordEvent(env, "system", "", "error", `batch ${bid} preview: ${err && err.message ? err.message : "unknown"}`);
  }
  return { prepared: claimed.length, batch: bid };
}

// پیش‌نمایش عین همون چیزیه که گروه می‌بینه؛ دکمه‌ها زیر آخرین بخش
async function sendPreview(env, bid, sections, count) {
  const owner = env.OWNER_ID;
  const chunks = chunkMessages(sections.flatMap((s) => s.blocks));
  await tg(env, "sendMessage", { chat_id: owner, text: `دسته‌ی ${bid}: ${count} پست جدید برای گروه. پیش‌نمایش:`, disable_web_page_preview: true });
  const markup = { inline_keyboard: [[{ text: "ارسال به گروه", callback_data: `sb:s:${bid}` }, { text: "رد", callback_data: `sb:r:${bid}` }]] };
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const reply_markup = i === chunks.length - 1 ? markup : undefined;
    const html = chunk.map((b) => b.html).join("\n");
    try {
      await tg(env, "sendMessage", { chat_id: owner, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
    } catch (err) {
      if (!CONTENT_ERROR.test(err.message || "")) throw err;
      await tg(env, "sendMessage", { chat_id: owner, text: chunk.map((b) => b.plain).join("\n"), disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
    }
  }
}

// بخش‌بندی ثابت: اولین بار تأیید، پست‌ها به بخش‌هایی (هر کدوم یک پیام) تقسیم و کلیدشون ثبت می‌شه.
async function planUnits(env, bid, posts, keywords) {
  const tag = crypto.randomUUID().slice(0, 8);
  const chunks = chunkMessages(buildSections(posts, keywords).flatMap((s) => s.blocks));
  for (let i = 0; i < chunks.length; i++) {
    const key = `scrape_batch:${bid}:${tag}:${i}`;
    for (const b of chunks[i]) {
      if (b.postId) {
        await env.DB.prepare("UPDATE scrape_batch_items SET unit = ? WHERE batch_id = ? AND post_id = ? AND unit IS NULL")
          .bind(key, bid, b.postId).run();
      }
    }
  }
}

// تأیید مالک. ctx: lease همین اجرای webhook (از ارسال بیرونی بدون lease جلوگیری می‌کنه)
export async function approveBatch(env, ctx, bid) {
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return "گروه تنظیم نشده.";
  const b = await env.DB.prepare("SELECT state, expires_utc FROM scrape_batches WHERE id = ?").bind(bid).first();
  if (!b) return "این دسته پیدا نشد.";
  if (b.state === "sent") return "این دسته قبلاً ارسال شده.";
  if (["rejected", "expired", "empty"].includes(b.state)) return `این دسته ${STATE_FA[b.state]} است.`;
  if (await scrapePaused(env)) return "ارسال به گروه متوقفه؛ اول /scrape_resume.";
  if (await inTehranQuietHours(env)) return "ساعت سکوته؛ بعد از ۰۶:۰۰ دوباره بزن.";
  if (b.state === "pending") {
    if (nowUtc() > b.expires_utc) {
      await expireBatches(env);
      return "این دسته منقضی شده؛ پست‌هاش در دسته‌ی بعدی می‌آن.";
    }
    // شرطی: اگه دو کلیک هم‌زمان باشه، یکی برنده می‌شه؛ بقیه‌ی کار با claim بخش‌ها امنه
    await env.DB.prepare("UPDATE scrape_batches SET state = 'sending' WHERE id = ? AND state = 'pending'").bind(bid).run();
  }

  const { results } = await env.DB.prepare(
    `SELECT p.*, bi.unit AS unit FROM posts p JOIN scrape_batch_items bi ON bi.post_id = p.id
     WHERE bi.batch_id = ? AND p.sent_at_utc IS NULL ORDER BY p.source, p.channel, p.first_seen_utc, p.id`
  ).bind(bid).all();
  if (!results.length) {
    await env.DB.prepare("UPDATE scrape_batches SET state = 'sent' WHERE id = ?").bind(bid).run();
    return "چیزی برای ارسال نمونده.";
  }
  const keywords = await keywordsList(env);
  const unplanned = results.filter((r) => !r.unit).map(forSend);
  if (unplanned.length) await planUnits(env, bid, unplanned, keywords);

  // بخش‌ها به ترتیب کلید (شماره‌ی بخش)
  const reloaded = await env.DB.prepare(
    `SELECT p.*, bi.unit AS unit FROM posts p JOIN scrape_batch_items bi ON bi.post_id = p.id
     WHERE bi.batch_id = ? AND p.sent_at_utc IS NULL`
  ).bind(bid).all();
  const byUnit = new Map();
  for (const r of reloaded.results) {
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, []);
    byUnit.get(r.unit).push(forSend(r));
  }
  const unitKeys = [...byUnit.keys()].sort((a, b) => Number(a.split(":").pop()) - Number(b.split(":").pop()));

  for (const key of unitKeys) {
    const unitPosts = byUnit.get(key);
    const ids = unitPosts.map((p) => p.id);
    const claim = await claimExternal(env, ctx, key, "scrape_batch");
    if (claim.status === "lease_lost") throw new LeaseLostError();
    if (claim.status === "done") { await markSent(env, ids); continue; }
    if (claim.status === "busy") return "این دسته هم‌اکنون در حال ارساله؛ چیزی دوبار فرستاده نشد.";
    if (claim.status === "ambiguous") throw new AmbiguousError(key);
    const blocks = buildSections(unitPosts, keywords).flatMap((s) => s.blocks);
    let msgId;
    try {
      msgId = await sendChunk(env, groupId, blocks, `batch ${bid}`);
    } catch (err) {
      if (err && err.refused) {
        await finishExternal(env, ctx, key, { ok: false, error: err.message });
        throw err;
      }
      throw new AmbiguousError(key);
    }
    await finishExternal(env, ctx, key, { ok: true, msgId, result: `posts ${ids.join(",")}` });
    await markSent(env, ids);
  }

  // عکس‌ها: یک آلبوم برای هر کانال؛ خطای قطعی عکس، متن را خراب نمی‌کنه
  const sections = buildSections(reloaded.results.map(forSend), keywords);
  for (const sec of sections) {
    if (!sec.photos.length) continue;
    const key = `scrape_batch:${bid}:photo:${sec.key}`;
    const claim = await claimExternal(env, ctx, key, "scrape_batch");
    if (claim.status === "lease_lost") throw new LeaseLostError();
    if (claim.status !== "claimed") continue; // done/busy: قبلاً فرستاده شده یا در حال ارسال
    try {
      const msgId = await sendPhotos(env, groupId, sec.label, sec.photos);
      await finishExternal(env, ctx, key, { ok: true, msgId, result: `photos ${sec.label}` });
    } catch (err) {
      if (err && err.refused) {
        await finishExternal(env, ctx, key, { ok: false, error: err.message });
        console.error("photo_error", err.message);
      } else {
        throw new AmbiguousError(key);
      }
    }
  }

  await env.DB.prepare("UPDATE scrape_batches SET state = 'sent' WHERE id = ? AND state = 'sending'").bind(bid).run();
  return `ارسال شد: ${reloaded.results.length} پست.`;
}

async function markSent(env, ids) {
  for (const id of ids) {
    await env.DB.prepare("UPDATE posts SET sent_at_utc = ? WHERE id = ? AND sent_at_utc IS NULL").bind(nowUtc(), id).run();
  }
}

export async function rejectBatch(env, bid) {
  const up = await env.DB.prepare("UPDATE scrape_batches SET state = 'rejected' WHERE id = ? AND state = 'pending'").bind(bid).run();
  if (up.meta.changes !== 1) {
    const b = await env.DB.prepare("SELECT state FROM scrape_batches WHERE id = ?").bind(bid).first();
    if (!b) return "این دسته پیدا نشد.";
    return `این دسته ${STATE_FA[b.state] || b.state} است؛ رد نشد.`;
  }
  await env.DB.prepare(
    "UPDATE posts SET sent_at_utc = ? WHERE sent_at_utc IS NULL AND id IN (SELECT post_id FROM scrape_batch_items WHERE batch_id = ?)"
  ).bind(nowUtc(), bid).run();
  return "دسته رد شد؛ این پست‌ها ارسال نمی‌شن.";
}

// دسته‌ی بی‌جواب: منقضی؛ عضوهاش آزاد می‌شن تا دسته‌ی بعدی (هیچ ارسالی نیست)
export async function expireBatches(env) {
  const { results } = await env.DB.prepare("SELECT id FROM scrape_batches WHERE state = 'pending' AND expires_utc < ?")
    .bind(nowUtc()).all();
  let expired = 0;
  for (const r of results) {
    const up = await env.DB.prepare("UPDATE scrape_batches SET state = 'expired' WHERE id = ? AND state = 'pending'").bind(r.id).run();
    if (up.meta.changes !== 1) continue;
    await env.DB.prepare("DELETE FROM scrape_batch_items WHERE batch_id = ?").bind(r.id).run();
    expired += 1;
    try {
      await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text: `دسته‌ی ${r.id} بی‌جواب ماند و منقضی شد؛ ارسال نشد. پست‌هاش در دسته‌ی بعدی پیشنهاد می‌شن.`, disable_web_page_preview: true });
    } catch (err) {
      console.error("expire_notify_failed", r.id);
    }
  }
  return { expired };
}

// دکمه‌های دسته (فقط مالک؛ مسیر را dispatch در index.js چک می‌کنه)
export async function handleBatchCallback(env, cq, ctx) {
  const [, action, raw] = String(cq.data).split(":");
  const bid = Number(raw);
  let text;
  try {
    if (!Number.isSafeInteger(bid) || bid <= 0) text = "نامعتبر";
    else if (action === "s") text = await approveBatch(env, ctx, bid);
    else if (action === "r") text = await rejectBatch(env, bid);
    else text = "نامعتبر";
  } catch (err) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "نتیجه نامشخص؛ در /review دیده می‌شه", show_alert: true }).catch(() => {});
    throw err;
  }
  return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: true });
}

