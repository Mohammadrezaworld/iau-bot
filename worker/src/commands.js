// دستورهای ادمین در DM. کاربرهای عادی در DM هیچ پاسخی نمی‌گیرن.
import { sendMessage, sendJsonDocument } from "./telegram.js";
import { isAdmin, isOwner, audit, buildBackup, statusText, logText, getRole } from "./admin.js";
import { answerPublic, getSetting } from "./public.js";
import { parseDateInput, normalizeDigits } from "./jalali.js";
import { startWizard, handleWizardText, removeList } from "./wizard.js";
import { updatesText, flushPosts } from "./channels.js";
import { tg } from "./telegram.js";
import { faDate } from "./calendar.js";
import { handleManage, publicContacts, publicResources, publicEvents, MANAGE_HELP } from "./manage.js";

// دستورهایی که سطح content هم مجازه
const CONTENT_CMDS = new Set([
  "/start", "/help", "/cancel", "/ok", "/status",
  "/call", "/links", "/events", "/updates",
  "/call_add", "/call_edit", "/call_remove", "/call_list",
  "/link_add", "/link_edit", "/link_remove", "/link_list",
  "/event_add", "/event_remove", "/event_list",
]);

export const PUBLIC_CMDS = ["/week", "/next", "/term", "/left", "/call", "/links", "/events", "/updates"];

export async function runPublic(env, chatId, cmd) {
  if (["/call"].includes(cmd)) return sendMessage(env, chatId, await publicContacts(env));
  if (["/links"].includes(cmd)) return sendMessage(env, chatId, await publicResources(env));
  if (["/events"].includes(cmd)) return sendMessage(env, chatId, await publicEvents(env));
  if (["/updates"].includes(cmd)) return sendMessage(env, chatId, await updatesText(env));
  return answerPublic(env, chatId, cmd);
}

export function parseCmd(text) {
  const t = (text || "").trim();
  const cmd = t.split(/\s+/)[0].toLowerCase().split("@")[0];
  const arg = t.slice(t.split(/\s+/)[0].length).trim();
  return { cmd, arg };
}

const HELP = [
  "دستورهای ادمین:",
  "/status — وضعیت ربات",
  "/log — ۲۰ تغییر آخر",
  "/backup — فایل پشتیبان",
  "/set_semester ۱۴۰۵-۰۶-۲۱ — شروع ترم (شنبه، شمسی)",
  "/set_group -100… — شناسه‌ی گروه",
  "/help — همین راهنما",
  "/cancel — لغو کار نیمه‌تمام",
  "/admins — فهرست ادمین‌ها (فقط مالک)",
  "/admin_add شناسه — افزودن ادمین و انتخاب سطح دسترسی (فقط مالک)",
  "/admin_remove شناسه — حذف ادمین (فقط مالک)",
  "",
  "افزودن رویداد/شماره/لینک: فقط دستور رو بزن (مثلاً /event_add) و مرحله‌به‌مرحله جواب بده.",
  "حذف: /event_remove یا /call_remove یا /link_remove رو بزن و از دکمه‌ها انتخاب کن.",
  "",
  MANAGE_HELP,
  "",
  "دستورهای عمومی (/week /next /term /left /call /links /events) هم در DM برای تست کار می‌کنن.",
].join("\n");

export async function handleAdminMessage(env, message) {
  const chatId = message.chat.id;
  const userId = message.from && message.from.id;
  if (!userId) return;

  // کاربر عادی: بی‌صدا نادیده گرفته می‌شه
  if (!(await isAdmin(env, userId))) return;

  const role = await getRole(env, userId);
  const { cmd, arg } = parseCmd(message.text);

  if (role === "content" && cmd.startsWith("/") && !CONTENT_CMDS.has(cmd)) {
    return sendMessage(env, chatId, "این دستور برای سطح دسترسی شما نیست.");
  }

  // اگه جریان مرحله‌به‌مرحله فعاله، متن ادمین جواب اون مرحله‌ست
  if (!cmd.startsWith("/") || cmd === "/cancel") {
    if (cmd === "/cancel") {
      await env.DB.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(userId).run();
      return sendMessage(env, chatId, "لغو شد.");
    }
    if (await handleWizardText(env, message)) return;
    return;
  }

  if (PUBLIC_CMDS.includes(cmd)) return runPublic(env, chatId, cmd);

  // افزودن بدون آرگومان: مرحله‌به‌مرحله. حذف بدون آرگومان: لیست با دکمه
  const wizardFlows = { "/event_add": "event", "/call_add": "call", "/link_add": "link" };
  if (wizardFlows[cmd] && !arg) return startWizard(env, userId, chatId, wizardFlows[cmd]);
  const removeTypes = { "/event_remove": "event", "/call_remove": "call", "/link_remove": "link" };
  if (removeTypes[cmd] && !arg) return removeList(env, chatId, removeTypes[cmd]);

  const managed = await handleManage(env, userId, cmd, arg);
  if (managed !== null) return sendMessage(env, chatId, managed);

  switch (cmd) {
    case "/start":
    case "/help":
      return sendMessage(env, chatId, HELP);
    case "/status":
      return sendMessage(env, chatId, await statusText(env));
    case "/log":
      return sendMessage(env, chatId, await logText(env));
    case "/backup":
      await audit(env, userId, "backup", "manual");
      return sendJsonDocument(env, chatId, "iaut-backup.json", await buildBackup(env), "پشتیبان دستی");
    case "/set_semester": {
      const iso = parseDateInput(arg);
      if (!iso) return sendMessage(env, chatId, "فرمت درست: /set_semester ۱۴۰۵-۰۶-۲۱ (شمسی)");
      const old = await getSetting(env, "semester_start", "");
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('semester_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(iso).run();
      await audit(env, userId, "set_semester", `${old} -> ${iso}`);
      return sendMessage(env, chatId, `شروع ترم ثبت شد: ${faDate(iso)}`);
    }
    case "/admins": {
      if (!(await isOwner(env, userId))) return;
      const { results } = await env.DB.prepare(
        "SELECT a.user_id, COALESCE(r.role, 'full') AS role FROM admins a LEFT JOIN admin_roles r ON r.user_id = a.user_id ORDER BY a.user_id"
      ).all();
      const roleName = { full: "کامل", content: "محتوا" };
      const list = [`مالک: ${env.OWNER_ID}`, ...results.map((r) => `${r.user_id} — ${roleName[r.role] || r.role}`)];
      return sendMessage(env, chatId, list.join("\n"));
    }
    case "/admin_add": {
      if (!(await isOwner(env, userId))) return; // فقط مالک، و بی‌صدا برای بقیه
      const id = normalizeDigits(arg);
      if (!/^\d{5,15}$/.test(id)) return sendMessage(env, chatId, "فرمت: /admin_add 123456789 (شناسه‌ی عددی تلگرام)");
      return tg(env, "sendMessage", {
        chat_id: chatId,
        text: `سطح دسترسی ادمین ${id} رو انتخاب کن:\n• کامل: همه‌ی دستورها\n• محتوا: فقط جزوه، شماره، لینک و رویداد`,
        reply_markup: {
          inline_keyboard: [[
            { text: "کامل", callback_data: `adm:full:${id}` },
            { text: "محتوا", callback_data: `adm:content:${id}` },
          ], [{ text: "لغو", callback_data: "w:cancel" }]],
        },
      });
    }
    case "/admin_remove": {
      if (!(await isOwner(env, userId))) return;
      const id = normalizeDigits(arg);
      if (!/^\d{5,15}$/.test(id)) return sendMessage(env, chatId, "فرمت: /admin_remove 123456789");
      if (id === String(env.OWNER_ID)) return sendMessage(env, chatId, "مالک قابل حذف نیست.");
      await env.DB.prepare("DELETE FROM admins WHERE user_id = ?").bind(Number(id)).run();
      await env.DB.prepare("DELETE FROM admin_roles WHERE user_id = ?").bind(Number(id)).run();
      await audit(env, userId, "admin_remove", id);
      return sendMessage(env, chatId, `ادمین ${id} حذف شد.`);
    }
    case "/set_group": {
      const gid = normalizeDigits(arg);
      if (!/^-?\d{5,20}$/.test(gid)) return sendMessage(env, chatId, "فرمت درست: /set_group -1001234567890");
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('group_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(gid).run();
      await audit(env, userId, "set_group", gid);
      return sendMessage(env, chatId, "شناسه‌ی گروه ثبت شد.");
    }
    default:
      return sendMessage(env, chatId, "دستور ناشناخته. /help رو بزن.");
  }
}

