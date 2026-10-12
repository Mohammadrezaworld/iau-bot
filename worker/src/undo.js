// /undo: برگشت آخرین تغییر کلمات کلیدی، تعطیلات و جابه‌جایی جدول مترو. فقط ۵ تغییر آخر نگه داشته می‌شن.
import { audit } from "./admin.js";

const LIMIT = 5;
const nowS = () => Math.floor(Date.now() / 1000);

// before = مقدار قبلی (null یعنی قبلاً نبوده)
// kind: "setting" (کلید در settings) یا "holiday" (key = تاریخ ISO، before = عنوان قبلی)
export async function pushUndo(env, label, kind, key, before) {
  await env.DB.prepare(
    "INSERT INTO undo_stack (created_utc, label, kind, key, before) VALUES (?, ?, ?, ?, ?)"
  ).bind(nowS(), String(label).slice(0, 200), kind, key, before ?? null).run();
  await env.DB.prepare(
    "DELETE FROM undo_stack WHERE id NOT IN (SELECT id FROM undo_stack ORDER BY id DESC LIMIT ?)"
  ).bind(LIMIT).run();
}

export async function undoLast(env, userId) {
  const row = await env.DB.prepare("SELECT * FROM undo_stack ORDER BY id DESC LIMIT 1").first();
  if (!row) return "چیزی برای برگشت نیست.";

  if (row.kind === "setting") {
    if (row.before === null) {
      await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(row.key).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(row.key, row.before).run();
    }
  } else if (row.kind === "holiday") {
    if (row.before === null) {
      await env.DB.prepare("DELETE FROM holidays WHERE date = ?").bind(row.key).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO holidays (date, title) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title"
      ).bind(row.key, row.before).run();
    }
  }

  await env.DB.prepare("DELETE FROM undo_stack WHERE id = ?").bind(row.id).run();
  await audit(env, userId, "undo", row.label);
  return `برگشت داده شد: ${row.label}`;
}
