// مدیریت شماره‌ها، لینک‌ها و رویدادها توسط ادمین (DM). حذف‌ها با تأیید ۶۰ ثانیه‌ای.
import { audit } from "./admin.js";
import { escHtml } from "./telegram.js";
import { faDate, faNum, tehranToday, daysBetween } from "./calendar.js";
import { parseDateInput, normalizeDigits } from "./jalali.js";

const nowUtc = () => Math.floor(Date.now() / 1000);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const parts = (arg) => normalizeDigits(arg).split("|").map((s) => s.trim());

export const MANAGE_HELP = [
  "شماره‌ها:",
  "/call_add دسته | نام | شماره | یادداشت",
  "/call_edit شناسه | دسته | نام | شماره | یادداشت",
  "/call_remove شناسه",
  "/call_list",
  "",
  "لینک‌ها:",
  "/link_add دسته | عنوان | https://…",
  "/link_edit شناسه | دسته | عنوان | https://…",
  "/link_remove شناسه",
  "/link_list",
  "",
  "رویدادها:",
  "/event_add ۱۴۰۵-۰۷-۲۸ | ۱۴۰۵-۰۷-۳۰ | عنوان | نوع   (پایان اختیاریه، تاریخ شمسی)",
  "/event_remove شناسه",
  "/event_list",
  "",
  "/ok شناسه — تأیید حذف (تا ۶۰ ثانیه)",
].join("\n");

async function createPending(env, actorId, action, payload) {
  const row = await env.DB.prepare(
    "INSERT INTO pending_actions (actor_id, action, payload, expires_utc) VALUES (?, ?, ?, ?) RETURNING id"
  ).bind(actorId, action, JSON.stringify(payload), nowUtc() + 60).first();
  return row.id;
}

export async function listContacts(env) {
  const { results } = await env.DB.prepare("SELECT * FROM contacts ORDER BY category, sort_order, id").all();
  if (!results.length) return "هنوز شماره‌ای ثبت نشده.";
  return results.map((c) => `${c.id} | ${c.category} | ${c.name} | ${c.number}${c.note ? " | " + c.note : ""}`).join("\n");
}

export async function listResources(env) {
  const { results } = await env.DB.prepare("SELECT * FROM resources ORDER BY category, sort_order, id").all();
  if (!results.length) return "هنوز لینکی ثبت نشده.";
  return results.map((r) => `${r.id} | ${r.category} | ${r.title} | ${r.url}`).join("\n");
}

export async function listEvents(env) {
  const { results } = await env.DB.prepare("SELECT * FROM events ORDER BY start_date, id").all();
  if (!results.length) return "هنوز رویدادی ثبت نشده.";
  return results.map((e) => `${e.id} | ${faDate(e.start_date)}${e.end_date !== e.start_date ? " تا " + faDate(e.end_date) : ""} | ${e.title}${e.kind ? " (" + e.kind + ")" : ""}`).join("\n");
}

// پردازش دستورهای مدیریتی. اگه دستور مربوط به این بخش نبود، null برمی‌گردونه.
export async function handleManage(env, userId, cmd, arg) {
  switch (cmd) {
    case "/call_add": {
      const [cat, name, number, note = ""] = parts(arg);
      if (!cat || !name || !number) return "فرمت: /call_add دسته | نام | شماره | یادداشت";
      await env.DB.prepare("INSERT INTO contacts (category, name, number, note) VALUES (?, ?, ?, ?)").bind(cat, name, number, note).run();
      await audit(env, userId, "call_add", `${cat} | ${name}`);
      return "شماره ثبت شد.";
    }
    case "/call_edit": {
      const [id, cat, name, number, note = ""] = parts(arg);
      if (!id || !cat || !name || !number) return "فرمت: /call_edit شناسه | دسته | نام | شماره | یادداشت";
      const r = await env.DB.prepare("UPDATE contacts SET category=?, name=?, number=?, note=? WHERE id=?").bind(cat, name, number, note, Number(id)).run();
      if (!r.meta || r.meta.changes === 0) return "شناسه پیدا نشد.";
      await audit(env, userId, "call_edit", id);
      return "شماره ویرایش شد.";
    }
    case "/call_remove": {
      const c = await env.DB.prepare("SELECT name FROM contacts WHERE id=?").bind(Number(arg)).first();
      if (!c) return "شناسه پیدا نشد.";
      const pid = await createPending(env, userId, "call_remove", { id: Number(arg) });
      return `برای حذف «${c.name}» بزن: /ok ${pid}\n(تا ۶۰ ثانیه)`;
    }
    case "/call_list":
      return listContacts(env);

    case "/link_add": {
      const [cat, title, url] = parts(arg);
      if (!cat || !title || !url) return "فرمت: /link_add دسته | عنوان | https://…";
      if (!/^https:\/\/\S+$/.test(url)) return "فقط لینک https قبول می‌شه.";
      await env.DB.prepare("INSERT INTO resources (category, title, url) VALUES (?, ?, ?)").bind(cat, title, url).run();
      await audit(env, userId, "link_add", title);
      return "لینک ثبت شد.";
    }
    case "/link_edit": {
      const [id, cat, title, url] = parts(arg);
      if (!id || !cat || !title || !url) return "فرمت: /link_edit شناسه | دسته | عنوان | https://…";
      if (!/^https:\/\/\S+$/.test(url)) return "فقط لینک https قبول می‌شه.";
      const r = await env.DB.prepare("UPDATE resources SET category=?, title=?, url=? WHERE id=?").bind(cat, title, url, Number(id)).run();
      if (!r.meta || r.meta.changes === 0) return "شناسه پیدا نشد.";
      await audit(env, userId, "link_edit", id);
      return "لینک ویرایش شد.";
    }
    case "/link_remove": {
      const r = await env.DB.prepare("SELECT title FROM resources WHERE id=?").bind(Number(arg)).first();
      if (!r) return "شناسه پیدا نشد.";
      const pid = await createPending(env, userId, "link_remove", { id: Number(arg) });
      return `برای حذف «${r.title}» بزن: /ok ${pid}\n(تا ۶۰ ثانیه)`;
    }
    case "/link_list":
      return listResources(env);

    case "/event_add": {
      const [startRaw, endRaw = "", title, kind = ""] = parts(arg);
      const start = parseDateInput(startRaw);
      if (!start) return "تاریخ شروع درست نیست. مثال: /event_add ۱۴۰۵-۰۷-۲۸ | | میان‌ترم | امتحان";
      const endParsed = endRaw ? parseDateInput(endRaw) : null;
      if (endRaw && !endParsed) return "تاریخ پایان درست نیست. یا خالی بذار یا مثل ۱۴۰۵-۰۷-۳۰ بنویس.";
      const endDate = endParsed || start;
      if (endDate < start) return "تاریخ پایان نباید قبل از شروع باشه.";
      if (!title) return "عنوان رویداد لازمه. مثال: /event_add ۱۴۰۵-۰۷-۲۸ | | میان‌ترم | امتحان";
      await env.DB.prepare("INSERT INTO events (start_date, end_date, title, kind) VALUES (?, ?, ?, ?)").bind(start, endDate, title, kind).run();
      await audit(env, userId, "event_add", `${start} ${title}`);
      return "رویداد ثبت شد.";
    }
    case "/event_remove": {
      const e = await env.DB.prepare("SELECT title FROM events WHERE id=?").bind(Number(arg)).first();
      if (!e) return "شناسه پیدا نشد.";
      const pid = await createPending(env, userId, "event_remove", { id: Number(arg) });
      return `برای حذف «${e.title}» بزن: /ok ${pid}\n(تا ۶۰ ثانیه)`;
    }
    case "/event_list":
      return listEvents(env);

    case "/ok": {
      const p = await env.DB.prepare("SELECT * FROM pending_actions WHERE id=? AND actor_id=?").bind(Number(arg), userId).first();
      if (!p) return "این تأیید پیدا نشد.";
      await env.DB.prepare("DELETE FROM pending_actions WHERE id=?").bind(p.id).run();
      if (p.expires_utc < nowUtc()) return "مهلت تأیید تموم شده. دوباره دستور حذف رو بزن.";
      const data = JSON.parse(p.payload);
      if (p.action === "call_remove") {
        await env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(data.id).run();
      } else if (p.action === "link_remove") {
        await env.DB.prepare("DELETE FROM resources WHERE id=?").bind(data.id).run();
      } else if (p.action === "event_remove") {
        await env.DB.prepare("DELETE FROM events WHERE id=?").bind(data.id).run();
      } else {
        return "عملیات ناشناخته.";
      }
      await audit(env, userId, p.action, String(data.id));
      return "حذف شد.";
    }
    default:
      return null;
  }
}

// نمای عمومی برای گروه
export async function publicEvents(env) {
  const today = tehranToday();
  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE archived = 0 AND end_date >= ? ORDER BY start_date, id LIMIT 15"
  ).bind(today).all();
  if (!results.length) return "رویداد مهمی در پیش نیست.";
  return ["رویدادهای مهم:", ...results.map((e) => {
    const d = daysBetween(today, e.start_date);
    const when = d < 0 ? "در جریان" : d === 0 ? "امروز" : `${faNum(d)} روز دیگه`;
    return `• ${faDate(e.start_date)}: ${e.title} (${when})`;
  })].join("\n");
}

// خروجی HTML: نام هر اداره داخل blockquote، شماره داخل code (با لمس کپی می‌شه)
export async function publicContacts(env) {
  const { results } = await env.DB.prepare("SELECT * FROM contacts ORDER BY category, sort_order, id").all();
  if (!results.length) return "هنوز شماره‌ای ثبت نشده.";
  const groups = {};
  for (const c of results) (groups[c.category] ||= []).push(c);
  const out = [];
  for (const [cat, items] of Object.entries(groups)) {
    out.push(`<b>【${escHtml(cat)}】</b>`);
    // هر دسته داخل یک blockquote جمع‌شونده: پیش‌فرض بسته، با باز کردن همه‌ی شماره‌ها دیده می‌شن
    const rows = items.map((c) => {
      const label = `${escHtml(c.name)}${c.note ? " (" + escHtml(c.note) + ")" : ""}`;
      return `${label}\n<code>${escHtml(c.number)}</code>`;
    });
    out.push(`<blockquote expandable>${rows.join("\n\n")}</blockquote>`, "");
  }
  out.push("جستجوی شماره‌ی کارکنان: /links");
  return out.join("\n");
}

export async function publicResources(env) {
  const { results } = await env.DB.prepare("SELECT * FROM resources ORDER BY category, sort_order, id").all();
  if (!results.length) return "هنوز لینکی ثبت نشده.";
  const groups = {};
  for (const r of results) (groups[r.category] ||= []).push(r);
  const out = [];
  for (const [cat, items] of Object.entries(groups)) {
    out.push(`【${cat}】`);
    for (const r of items) out.push(`• ${r.title}: ${r.url}`);
  }
  return out.join("\n");
}
