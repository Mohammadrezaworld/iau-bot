// دسته‌ی پست‌های اسکرپ برای تأیید مالک.
// - prepareBatch: پست‌های جدید (بدون دسته) را در یک دسته می‌گذاره و پیش‌نمایش را به پیوی مالک می‌فرسته. پست جدید نباشه، دسته‌ای ساخته نمی‌شه.
// - approveBatch: با تأیید مالک، هر بخش ارسال با claim در effects فرستاده می‌شه؛ دوبار ارسال یا retry، بخش ارسال‌شده را دوباره نمی‌فرسته.
// - rejectBatch: پست‌های دسته دیگه پیشنهاد نمی‌شن.
// - expireBatches: دسته‌ی بی‌جواب بعد از مهلت منقضی می‌شه و پست‌هاش در دسته‌ی بعدی می‌آن (هیچ ارسال خودکاری نیست).
import { tg } from "./telegram.js";
import { getSetting } from "./public.js";
import { recordEvent } from "./monitor.js";
import { readModeSnapshot, inTehranQuietHours, keywordsList, cleanPostText, isJunkBalePost, buildSections, chunkMessages, sendChunk, sendPhotos } from "./channels.js";
import { claimExternal, finishExternal, AmbiguousError, LeaseLostError } from "./effects.js";
import { setOutcome } from "./outcomes.js";
import { claimUpdate, markOutcome, markDoneWithRetry, notifyNeedsReview } from "./updates.js";

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
  const snap = await readModeSnapshot(env);
  if (snap.mode === "stop") return { skipped: "paused" };
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return { skipped: "no_group" };

  const { results } = await env.DB.prepare(
    `SELECT * FROM posts WHERE sent_at_utc IS NULL AND id NOT IN (SELECT post_id FROM scrape_batch_items)
     ORDER BY source, channel, first_seen_utc, id LIMIT 200`
  ).all();
  if (!results.length) return { prepared: 0 };

  // پست‌های جنک بدون ارسال علامت می‌خورن؛ پست کوتاه تلگرام جنک نیست.
  const candidates = [];
  for (const p of results) {
    const junk = (p.source === "bale" && isJunkBalePost(p))
      || (p.source === "telegram" && !p.text && !p.image_url);
    if (junk) {
      await setOutcome(env, [p.id], "junk");
      await env.DB.prepare("UPDATE posts SET sent_at_utc = ? WHERE id = ?").bind(nowUtc(), p.id).run();
    } else {
      candidates.push(p);
    }
  }
  if (!candidates.length) return { prepared: 0 };

  // خودکار: فقط پست‌هایی که بعد از فعال‌شدن دیده شدن خودکار می‌رن؛ بقیه (معوق/قدیمی‌تر) فقط پیش‌نمایش دستی
  const since = snap.since;
  const autoPosts = snap.mode === "auto" ? candidates.filter((p) => Number(p.first_seen_utc) > since) : [];
  const manualPosts = candidates.filter((p) => !autoPosts.includes(p));
  let prepared = 0;
  let batch = null;
  if (manualPosts.length) {
    const r = await createBatch(env, groupId, manualPosts, false);
    prepared += r.prepared; batch = r.batch ?? batch;
  }
  if (autoPosts.length) {
    const r = await createBatch(env, groupId, autoPosts, true, since);
    prepared += r.prepared; batch = r.batch ?? batch;
  }
  return { prepared, batch };
}

// یک دسته: ساخت، claim اتمی هر پست، و بعد پیش‌نمایش (دستی) یا ارسال خودکار
export async function createBatch(env, groupId, posts, auto, epoch = 0) {
  const now = nowUtc();
  const created = await env.DB.prepare("INSERT INTO scrape_batches (state, created_utc, expires_utc) VALUES ('pending', ?, ?) RETURNING id")
    .bind(now, now + BATCH_TTL_S).first();
  const bid = created.id;
  // claim اتمی: هر پست فقط با INSERT OR IGNORE (کلید post_id) به یک دسته می‌ره؛ دو اجرای هم‌زمان مجموعه‌های جدا می‌گیرن
  const res = await env.DB.batch(posts.map((p) =>
    env.DB.prepare("INSERT OR IGNORE INTO scrape_batch_items (post_id, batch_id) VALUES (?, ?)").bind(p.id, bid)
  ));
  const claimed = posts.filter((_, i) => res[i].meta.changes === 1);
  if (!claimed.length) {
    await env.DB.prepare("UPDATE scrape_batches SET state = 'empty' WHERE id = ?").bind(bid).run();
    return { prepared: 0 };
  }
  if (auto) {
    const r = await autoApprove(env, bid, epoch);
    return { prepared: claimed.length, batch: bid, auto: r };
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

// ارسال خودکار زیر یک update مصنوعی (lease واقعی). اگه نتیجه مبهم بشه، مثل webhook در /review می‌آد.
// شناسه‌ی منفی است تا با شناسه‌های تلگرام تداخل نکنه.
// پیش‌نمایش دوباره‌ی دسته‌ی هنوز pending (مثلاً وقتی خودکار پیش از شروع متوقف شد):
// همان دکمه‌های تأیید/رد دستی، تا مالک بتواند تصمیم بگیرد.
async function resendPreview(env, bid) {
  const keywords = await keywordsList(env);
  const posts = (await batchPosts(env, bid, true)).map(forSend);
  if (!posts.length) return;
  await sendPreview(env, bid, buildSections(posts, keywords), posts.length);
}

export async function autoApprove(env, bid, epoch) {
  const id = -(Math.floor(Date.now() * 1000) + Math.floor(Math.random() * 1000));
  // epoch = زمان فعال‌سازی خودکار که این دسته تحتش ساخته شد؛ هر ارسال خودکار قبل از تماس تازه دوباره با آن مقایسه می‌شه
  const payload = { kind: "auto_batch", batch: bid, epoch };
  const claim = await claimUpdate(env, id, JSON.stringify(payload));
  if (claim.status !== "claimed") return { skipped: claim.status };
  const ctx = { updateId: id, lease: claim.lease, auto: true, epoch };
  let msg = "";
  try {
    msg = await approveBatch(env, ctx, bid);
    const st = await env.DB.prepare("SELECT state FROM scrape_batches WHERE id = ?").bind(bid).first();
    await markDoneWithRetry(env, id, ctx.lease);
    if (st && st.state === "pending") {
      // پیش از شروع متوقف شد: دسته منتظر تأیید مالک می‌ماند و پیش‌نمایش دستی دوباره می‌آید (نه ambiguous، نه انتشار)
      await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text: `ارسال خودکار (دسته ${bid}) شروع نشد: ${msg}`, disable_web_page_preview: true }).catch(() => {});
      await resendPreview(env, bid).catch((e) => console.error("resend_preview_failed", bid, e && e.message));
      return { held: msg };
    }
  } catch (err) {
    if (err && err.name === "LeaseLostError") return { lease_lost: true };
    const text = err && err.message ? err.message : "unknown";
    const reason = err && err.name === "AmbiguousError" ? "ambiguous" : "error";
    await markOutcome(env, id, ctx.lease, "needs_review", text, reason).catch(() => console.error("mark_outcome_failed", id));
    await notifyNeedsReview(env, id, payload, text, reason).catch(() => console.error("notify_review_failed", id));
    return { needs_review: reason };
  }
  await tg(env, "sendMessage", { chat_id: env.OWNER_ID, text: `ارسال خودکار (دسته ${bid}): ${msg}`, disable_web_page_preview: true }).catch(() => {});
  return { sent: msg };
}

// پیش‌نمایش عین همون چیزیه که گروه می‌بینه؛ دکمه‌ها زیر آخرین بخش
async function sendPreview(env, bid, sections, count) {
  const owner = env.OWNER_ID;
  const chunks = chunkMessages(sections.flatMap((s) => s.blocks));
  await tg(env, "sendMessage", { chat_id: owner, text: `دسته‌ی ${bid}: ${count} پست جدید برای گروه. پیش‌نمایش:`, disable_web_page_preview: true });
  // عکس‌های هر بخش، همان‌طور که در گروه می‌آید؛ خطای عکس جلوی پیش‌نمایش متنی و دکمه‌ها را نمی‌گیرد
  for (const sec of sections) {
    if (!sec.photos || !sec.photos.length) continue;
    try {
      await sendPhotos(env, owner, sec.label, sec.photos);
    } catch (err) {
      const reason = err && err.message ? err.message.slice(0, 120) : "unknown";
      console.error("preview_photo_error", bid, reason);
      await tg(env, "sendMessage", { chat_id: owner, text: `عکس «${sec.label}» نرسید: ${reason}`, disable_web_page_preview: true }).catch(() => {});
    }
  }
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
// توقف فعلی: سکوت یا توقف انتشار. قبل از هر تماس تازه با تلگرام دوباره خوانده می‌شه.
// ctx.auto: اجرای خودکار فقط وقتی مجاز است که حالت هنوز «خودکار» و cutoff همان فعال‌سازی باشد.
// تغییر به دستی/توقف یا فعال‌سازی دوباره (cutoff جدید) باعث می‌شه باقی‌مانده برای تصمیم صریح مالک بماند.
async function stopReason(env, ctx) {
  if (await inTehranQuietHours(env)) return "quiet";
  const snap = await readModeSnapshot(env);
  if (snap.paused) return "paused";
  if (ctx && ctx.auto && (snap.mode !== "auto" || snap.since !== Number(ctx.epoch))) return "auth";
  return null;
}
const STOP_TEXT = {
  quiet: "ساعت سکوته؛ بعد از ۰۶:۰۰ دوباره بزن.",
  paused: "ارسال به گروه متوقفه؛ اول /scrape_settings.",
  auth: "حالت ارسال خودکار تغییر کرد؛ باقی‌مانده برای تصمیم تو نگه داشته شد (از /review با «ادامه» بزن).",
};
const WHY_TEXT = {
  quiet: "ساعت سکوت شروع شد",
  paused: "ارسال متوقف است",
  auth: "حالت خودکار تغییر کرد",
};

const photoKey = (bid, sectionKey) => `scrape_batch:${bid}:photo:${sectionKey}`;

// پست‌های دسته؛ onlyUnsent: فقط آن‌هایی که متنشان هنوز نرفته
async function batchPosts(env, bid, onlyUnsent) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, bi.unit AS unit FROM posts p JOIN scrape_batch_items bi ON bi.post_id = p.id
     WHERE bi.batch_id = ?${onlyUnsent ? " AND p.sent_at_utc IS NULL" : ""} ORDER BY p.source, p.channel, p.first_seen_utc, p.id`
  ).bind(bid).all();
  return results;
}
// بخش‌های عکس از همه‌ی پست‌های دسته (حتی آن‌هایی که متنشان قبلاً رفته)؛ متن عکس از پست‌های معوق نمی‌آد
function photoSections(posts) {
  return buildSections(posts.map(forSend), []).filter((s) => s.photos.length).map((s) => ({ key: s.key, label: s.label, photos: s.photos }));
}
// پست تنها عکسِ بخش با متن کوتاه (≤ ۱۰۰۰ کاراکتر): متنش زیر عکس می‌آد. عضویت از همه‌ی پست‌های دسته گرفته می‌شه تا پایدار بمونه.
const CAPTION_MAX = 1000;
function captionPostIds(posts) {
  const ids = new Set();
  for (const sec of photoSections(posts)) {
    if (sec.photos.length !== 1) continue;
    const p = sec.photos[0];
    if ((p.text || "").trim().length <= CAPTION_MAX) ids.add(p.id);
  }
  return ids;
}
// بخش‌های عکسی که تأیید «done» ندارن (صرف‌نظرشده هم done حساب می‌شه)
async function pendingPhotoSections(env, bid) {
  const out = [];
  for (const sec of photoSections(await batchPosts(env, bid, false))) {
    const e = await env.DB.prepare("SELECT state FROM effects WHERE op_key = ?").bind(photoKey(bid, sec.key)).first();
    if (!e || e.state !== "done") out.push({ ...sec, state: e ? e.state : "none" });
  }
  return out;
}

// تأیید مالک یا ادامه‌ی دسته. ctx: lease همین اجرای webhook.
// هر واحد = یک پیام = یک اثر. قبل از هر تماس تازه: سکوت/توقف بررسی می‌شه؛ نتیجه‌ی مبهم هرگز خودکار تکرار نمی‌شه.
export async function approveBatch(env, ctx, bid) {
  const groupId = await getSetting(env, "group_id", "");
  if (!groupId) return "گروه تنظیم نشده.";
  const b = await env.DB.prepare("SELECT state, expires_utc FROM scrape_batches WHERE id = ?").bind(bid).first();
  if (!b) return "این دسته پیدا نشد.";
  if (b.state === "sent") return "این دسته قبلاً ارسال شده.";
  if (["rejected", "expired", "empty"].includes(b.state)) return `این دسته ${STATE_FA[b.state]} است.`;
  const early = await stopReason(env, ctx);
  if (early) return STOP_TEXT[early];
  if (b.state === "pending") {
    if (nowUtc() > b.expires_utc) {
      await expireBatches(env);
      return "این دسته منقضی شده؛ پست‌هاش در دسته‌ی بعدی می‌آن.";
    }
    // CAS: فقط یک اجرا pending→sending را می‌بره. اگه در این فاصله رد/انقضا شد، هیچ ارسالی نمی‌شه.
    const up = await env.DB.prepare("UPDATE scrape_batches SET state = 'sending' WHERE id = ? AND state = 'pending'").bind(bid).run();
    if (up.meta.changes !== 1) {
      const cur = await env.DB.prepare("SELECT state FROM scrape_batches WHERE id = ?").bind(bid).first();
      if (!cur || cur.state !== "sending") return `این دسته ${STATE_FA[cur ? cur.state : ""] || "در دسترس نیست"}؛ چیزی ارسال نشد.`;
    }
  }

  const keywords = await keywordsList(env);
  const unplanned = (await batchPosts(env, bid, true)).filter((r) => !r.unit).map(forSend);
  if (unplanned.length) await planUnits(env, bid, unplanned, keywords);
  const byUnit = new Map();
  const captionIds = captionPostIds(await batchPosts(env, bid, false));
  for (const r of await batchPosts(env, bid, true)) {
    if (!r.unit || captionIds.has(r.id)) continue; // پست کپشن‌دار جدا از متن و زیر عکس فرستاده می‌شه
    if (!byUnit.has(r.unit)) byUnit.set(r.unit, []);
    byUnit.get(r.unit).push(forSend(r));
  }
  const queue = [...byUnit.keys()].sort((x, y) => Number(x.split(":").pop()) - Number(y.split(":").pop()));

  let sentNow = 0;
  let refused = 0;
  let stoppedBy = null;
  let busy = false;
  for (let qi = 0; qi < queue.length; qi++) {
    const key = queue[qi];
    const unitPosts = byUnit.get(key);
    const ids = unitPosts.map((p) => p.id);
    stoppedBy = await stopReason(env, ctx);
    if (stoppedBy) break;
    const claim = await claimExternal(env, ctx, key, "scrape_batch");
    if (claim.status === "lease_lost") throw new LeaseLostError();
    if (claim.status === "done") { await markSent(env, ids); continue; }
    if (claim.status === "busy") { busy = true; break; }
    // نتیجه‌ی نامشخص قبلی: هرگز خودکار دوباره فرستاده نمی‌شه؛ تصمیم با مالک در /review
    if (claim.status === "ambiguous") continue;
    // بعد از claim هم بررسی: اگه سکوت شروع شده، تماسی انجام نشده و این واحد قطعاً نرفته
    stoppedBy = await stopReason(env, ctx);
    if (stoppedBy) { await finishExternal(env, ctx, key, { ok: false, error: `not_sent_${stoppedBy}` }); break; }

    const blocks = buildSections(unitPosts, keywords).flatMap((s) => s.blocks);
    let msgId;
    try {
      msgId = await sendChunk(env, groupId, blocks, `batch ${bid}`, () => stopReason(env, ctx));
    } catch (err) {
      if (err && err.stopped) {
        // HTML رد شده و تلاش ساده قبل از تماس متوقف شد: هیچ پیامی نرفته؛ واحد قابل ادامه می‌ماند
        await finishExternal(env, ctx, key, { ok: false, error: `not_sent_${err.stopped}` });
        stoppedBy = err.stopped;
        break;
      }
      if (err && err.contentRefused) {
        // محتوای این واحد در هر دو قالب رد شد؛ هیچ پیامی تحویل نشده
        await finishExternal(env, ctx, key, { ok: false, error: err.message });
        if (unitPosts.length > 1) {
          // تجزیه به واحدهای تک‌پست با کلید پایدار؛ هر کدام اثر جدای خودش را دارد
          const subs = [];
          for (const p of unitPosts) {
            const sk = `${key}:p${p.id}`;
            await env.DB.prepare("UPDATE scrape_batch_items SET unit = ? WHERE batch_id = ? AND post_id = ?").bind(sk, bid, p.id).run();
            byUnit.set(sk, [p]);
            subs.push(sk);
          }
          queue.splice(qi + 1, 0, ...subs);
        } else {
          await closeRefused(env, ids);
          refused += ids.length;
        }
        continue;
      }
      if (err && err.refused) {
        await finishExternal(env, ctx, key, { ok: false, error: err.message });
        throw err;
      }
      throw new AmbiguousError(key);
    }
    const recorded = await finishExternal(env, ctx, key, { ok: true, msgId, result: `posts ${ids.join(",")}` });
    // پیام رفته ولی ثبتش نشده: پست‌ها sent نمی‌شن و اثر نامشخص می‌مونه تا مالک تصمیم بگیره
    if (!recorded) throw new AmbiguousError(key);
    await markSent(env, ids);
    sentNow += ids.length;
  }

  // عکس‌ها: هر بخش یک اثر مستقل. موفقیت متن، عکس ناتمام را از صف خارج نمی‌کنه.
  if (!stoppedBy && !busy) {
    const capIds = captionPostIds(await batchPosts(env, bid, false));
    for (const sec of photoSections(await batchPosts(env, bid, false))) {
      stoppedBy = await stopReason(env, ctx);
      if (stoppedBy) break;
      const pkey = photoKey(bid, sec.key);
      // پست کپشن‌دار: متنش زیر عکس رفته؛ بعد از موفقیت عکس (یا اگه قبلاً done بوده) ارسال‌شده ثبت می‌شه
      const cap = sec.photos.length === 1 && capIds.has(sec.photos[0].id) ? sec.photos[0] : null;
      const claim = await claimExternal(env, ctx, pkey, "scrape_batch");
      if (claim.status === "lease_lost") throw new LeaseLostError();
      if (claim.status === "done" && cap) await markSent(env, [cap.id]);
      if (claim.status !== "claimed") continue; // done: کامل؛ busy/ambiguous: بماند برای مالک یا اجرای دیگر
      stoppedBy = await stopReason(env, ctx);
      if (stoppedBy) { await finishExternal(env, ctx, pkey, { ok: false, error: `not_sent_${stoppedBy}` }); break; }
      let msgId;
      try {
        msgId = await sendPhotos(env, groupId, sec.label, sec.photos, cap ? (cap.text || "").trim() || null : null);
      } catch (err) {
        if (err && err.refused) {
          // تلگرام صریحاً رد کرده: عکس نرفته؛ با «ادامه» دوباره امتحان می‌شه
          await finishExternal(env, ctx, pkey, { ok: false, error: err.message });
          console.error("photo_refused", pkey);
          continue;
        }
        throw new AmbiguousError(pkey);
      }
      const recorded = await finishExternal(env, ctx, pkey, { ok: true, msgId, result: `photos ${sec.label}` });
      if (!recorded) throw new AmbiguousError(pkey);
      if (cap) { await markSent(env, [cap.id]); sentNow += 1; }
    }
  }

  if (busy) return "این دسته هم‌اکنون در حال ارساله؛ چیزی دوبار فرستاده نشد.";
  const leftTexts = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts p JOIN scrape_batch_items bi ON bi.post_id = p.id WHERE bi.batch_id = ? AND p.sent_at_utc IS NULL"
  ).bind(bid).first()).n;
  const leftPhotos = (await pendingPhotoSections(env, bid)).length;
  const refusedNote = refused ? `${refused} پست را تلگرام به‌خاطر محتوا نپذیرفت (ارسال نشد و در /scrape_status ثبت شد).` : "";
  if (leftTexts === 0 && leftPhotos === 0) {
    await env.DB.prepare("UPDATE scrape_batches SET state = 'sent' WHERE id = ? AND state = 'sending'").bind(bid).run();
    return [`ارسال شد: ${sentNow} پست.`, refusedNote].filter(Boolean).join(" ");
  }
  // دسته sending می‌مونه؛ از /review با «ادامه» قابل بازیابیه
  const why = stoppedBy ? WHY_TEXT[stoppedBy] : "";
  return [
    `ارسال ناقص: ${sentNow} پست رفت، ${leftTexts} پست و ${leftPhotos} بخش عکس هنوز نرفته.`,
    why ? `${why}؛ باقی‌مانده نگه داشته شد.` : "",
    refusedNote,
  ].filter(Boolean).join(" ");
}

// پست‌هایی که تلگرام به‌خاطر محتوا نپذیرفت: از صف خارج، با outcome=telegram_refused (نه delivered)
async function closeRefused(env, ids) {
  await setOutcome(env, ids, "telegram_refused");
  for (const id of ids) {
    await env.DB.prepare("UPDATE posts SET sent_at_utc = ? WHERE id = ? AND sent_at_utc IS NULL").bind(nowUtc(), id).run();
  }
}

// صرف‌نظر مالک از عکس‌های نرفته یا ردشده. عکس مبهم را صرف‌نظر نمی‌کنیم (باید در /review تعیین شود).
export async function skipPhotos(env, bid) {
  let n = 0;
  const nowS = Math.floor(Date.now() / 1000);
  const capIds = captionPostIds(await batchPosts(env, bid, false));
  for (const sec of await pendingPhotoSections(env, bid)) {
    if (sec.state === "intent") continue;
    const key = photoKey(bid, sec.key);
    // پست کپشن‌دار: عکسش صرف‌نظر می‌شه ولی متنش نباید گم بشه؛ اول متن جدا فرستاده می‌شه، بعد اثر عکس بسته می‌شه
    const cap = sec.photos.length === 1 && capIds.has(sec.photos[0].id) ? sec.photos[0] : null;
    if (cap) {
      await tg(env, "sendMessage", { chat_id: await getSetting(env, "group_id", ""), text: `${sec.label}\n${(cap.text || "").trim()}` });
      await markSent(env, [cap.id]);
    }
    if (sec.state === "none") {
      await env.DB.prepare("INSERT OR IGNORE INTO effects (op_key, kind, state, update_id, lease, result, at_utc) VALUES (?, 'scrape_batch', 'done', NULL, '', 'owner_skipped', ?)").bind(key, nowS).run();
    } else {
      await env.DB.prepare("UPDATE effects SET state = 'done', result = 'owner_skipped', last_error = '' WHERE op_key = ? AND state = 'failed'").bind(key).run();
    }
    n += 1;
  }
  return n;
}

// دسته‌هایی که در sending مانده‌اند و هنوز متن یا عکس دارند (برای /review). هیچ زمان‌انقضایی ندارند.
export async function listStalledBatches(env) {
  const { results } = await env.DB.prepare(
    `SELECT b.id AS id,
       (SELECT COUNT(*) FROM scrape_batch_items bi JOIN posts p ON p.id = bi.post_id WHERE bi.batch_id = b.id AND p.sent_at_utc IS NULL) AS left_n,
       (SELECT COUNT(*) FROM scrape_batch_items bi JOIN posts p ON p.id = bi.post_id
          WHERE bi.batch_id = b.id AND p.sent_at_utc IS NULL AND EXISTS (SELECT 1 FROM effects e WHERE e.op_key = bi.unit AND e.state = 'intent')) AS amb_n
     FROM scrape_batches b WHERE b.state = 'sending' ORDER BY b.id`
  ).all();
  const out = [];
  for (const r of results) {
    const photos = await pendingPhotoSections(env, r.id);
    const photoAmb = photos.filter((x) => x.state === "intent").length;
    if (r.left_n > 0 || photos.length) out.push({ id: r.id, left_n: r.left_n, amb_n: r.amb_n + photoAmb, photo_n: photos.length });
  }
  return out;
}

async function markSent(env, ids) {
  await setOutcome(env, ids, "delivered");
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
  const queued = await env.DB.prepare(
    "SELECT p.id AS id FROM posts p JOIN scrape_batch_items bi ON bi.post_id = p.id WHERE bi.batch_id = ? AND p.sent_at_utc IS NULL"
  ).bind(bid).all();
  await setOutcome(env, queued.results.map((r) => r.id), "rejected");
  await env.DB.prepare(
    "UPDATE posts SET sent_at_utc = ? WHERE sent_at_utc IS NULL AND id IN (SELECT post_id FROM scrape_batch_items WHERE batch_id = ?)"
  ).bind(nowUtc(), bid).run();
  return "دسته رد شد؛ این پست‌ها ارسال نمی‌شن.";
}

// دسته‌ی بی‌جواب: منقضی؛ عضوهاش آزاد می‌شن تا دسته‌ی بعدی (هیچ ارسالی نیست).
// فقط pending منقضی می‌شه؛ دسته‌ی sending (ارسال ناقص) هرگز خودکار آزاد نمی‌شه.
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

// ادامه‌ی دسته‌ی ناقص: فقط وقتی sending است. بخش‌های موفق و مبهم دوباره فرستاده نمی‌شن.
export async function continueBatch(env, ctx, bid) {
  const b = await env.DB.prepare("SELECT state FROM scrape_batches WHERE id = ?").bind(bid).first();
  if (!b) return "این دسته پیدا نشد.";
  if (b.state !== "sending") return `این دسته برای ادامه باز نیست (${STATE_FA[b.state] || b.state}).`;
  return approveBatch(env, ctx, bid);
}

// دکمه‌های دسته (فقط مالک؛ مسیر را dispatch در index.js چک می‌کنه)
export async function handleBatchCallback(env, cq, ctx) {
  const [, action, raw] = String(cq.data).split(":");
  const bid = Number(raw);
  let text;
  try {
    if (!Number.isSafeInteger(bid) || bid <= 0) text = "نامعتبر";
    else if (action === "s") text = await approveBatch(env, ctx, bid);
    else if (action === "c") text = await continueBatch(env, ctx, bid);
    else if (action === "k") {
      const b = await env.DB.prepare("SELECT state FROM scrape_batches WHERE id = ?").bind(bid).first();
      if (!b || b.state !== "sending") text = "این دسته برای این کار باز نیست.";
      else {
        const n = await skipPhotos(env, bid);
        text = `${n} بخش عکس صرف‌نظر شد. ${await continueBatch(env, ctx, bid)}`;
      }
    }
    else if (action === "r") text = await rejectBatch(env, bid);
    else text = "نامعتبر";
  } catch (err) {
    // Router callback را زود ack کرده؛ هشدار toast دیگر دیده نمی‌شود، پس نتیجه را روی پیش‌نمایش نگه می‌داریم.
    await showBatchResult(env, cq.message, "نتیجه نامشخص؛ در /review دیده می‌شه");
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "نتیجه نامشخص؛ در /review دیده می‌شه", show_alert: true }).catch(() => {});
    throw err;
  }
  // نتیجه زیر همان پیش‌نمایش نوشته می‌شه؛ ack زودهنگام پیشاپیش spinner تلگرام را بسته.
  await showBatchResult(env, cq.message, text);
  return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: String(text).slice(0, 190) });
}

async function showBatchResult(env, msg, text) {
  if (!msg || !msg.text || msg.text.length > 3500) return;
  await tg(env, "editMessageText", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    text: `${msg.text}\n\nنتیجه: ${String(text).slice(0, 300)}`,
    entities: msg.entities,
  }).catch(() => {});
}
