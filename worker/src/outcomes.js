// وضعیت نهایی هر پست. sent_at_utc فقط می‌گه «دیگه در صف نیست»؛ این جدول می‌گه چرا.
// ارسال واقعی به گروه فقط با outcome «delivered» (تأیید ربات) ثبت می‌شه.
// پست‌هایی که قبل از این جدول sent شده‌اند، outcome ندارن و جدا شمرده می‌شن.

export const OUTCOME_LABELS = {
  delivered: "تأیید ربات (در گروه)",
  owner_applied: "تأیید مالک (اثر انجام شد)",
  rejected: "رد شده",
  telegram_refused: "تلگرام به‌خاطر محتوا نپذیرفت (ارسال نشد)",
  held_flood: "کنار گذاشته شده (سیل)",
  skipped_resume: "بدون ارسال (ادامه‌ی بدون backlog)",
  junk: "فوتر/عدد (بدون محتوا)",
  baseline: "پایه‌گذاری اولیه",
  old: "قدیمی",
  undated: "بی‌تاریخ",
  dry_run: "حالت آزمایشی",
};

const nowS = () => Math.floor(Date.now() / 1000);

// ثبت وضعیت برای لیست شناسه‌ها. اولین وضعیت می‌مونه (INSERT OR IGNORE).
export async function setOutcome(env, ids, outcome) {
  for (const id of ids) {
    await env.DB.prepare("INSERT OR IGNORE INTO post_outcomes (post_id, outcome, at_utc) VALUES (?, ?, ?)")
      .bind(id, outcome, nowS()).run();
  }
}

// گزارش وضعیت برای /scrape_status: شمارش بر اساس نتیجه‌ی واقعی، نه صرف sent
export async function statusReport(env) {
  const { results } = await env.DB.prepare("SELECT outcome, COUNT(*) AS n FROM post_outcomes GROUP BY outcome").all();
  const n = (k) => (results.find((r) => r.outcome === k) || { n: 0 }).n;
  const unsent = (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE sent_at_utc IS NULL").first()).n;
  const legacy = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts p WHERE p.sent_at_utc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM post_outcomes o WHERE o.post_id = p.id)"
  ).first()).n;
  const stalled = (await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_batches WHERE state = 'sending'").first()).n;
  return [
    `تأیید ربات (در گروه): ${n("delivered")}`,
    `تأیید مالک (اثر انجام شد): ${n("owner_applied")}`,
    `رد توسط تلگرام (محتوا، ارسال نشد): ${n("telegram_refused")}`,
    `کنار گذاشته‌شده: سیل ${n("held_flood")} · رد ${n("rejected")} · بدون ارسال ${n("skipped_resume")} · فوتر ${n("junk")} · قدیمی/بی‌تاریخ/آزمایشی/اولیه ${n("old") + n("undated") + n("dry_run") + n("baseline")}`,
    `علامت‌خورده‌ی قبل از ثبت جزئیات: ${legacy}`,
    `معوق (هنوز بررسی نشده): ${unsent}`,
    stalled ? `دسته‌ی ناقص منتظر ادامه: ${stalled} (در /review)` : null,
  ].filter(Boolean).join("\n");
}
