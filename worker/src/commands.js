// دستورهای ادمین در DM. کاربرهای عادی در DM هیچ پاسخی نمی‌گیرن.
import { sendMessage, sendJsonDocument } from "./telegram.js";
import { isAdmin, audit, buildBackup, statusText, logText } from "./admin.js";
import { answerPublic, getSetting } from "./public.js";
import { parseDateInput, normalizeDigits } from "./jalali.js";
import { faDate } from "./calendar.js";
import { handleManage, publicContacts, publicResources, publicEvents, MANAGE_HELP } from "./manage.js";

export const PUBLIC_CMDS = ["/week", "/next", "/term", "/left", "/call", "/links", "/events"];

export async function runPublic(env, chatId, cmd) {
  if (["/call"].includes(cmd)) return sendMessage(env, chatId, await publicContacts(env));
  if (["/links"].includes(cmd)) return sendMessage(env, chatId, await publicResources(env));
  if (["/events"].includes(cmd)) return sendMessage(env, chatId, await publicEvents(env));
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

  const { cmd, arg } = parseCmd(message.text);

  if (PUBLIC_CMDS.includes(cmd)) return runPublic(env, chatId, cmd);

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
    case "/set_group": {
      const gid = normalizeDigits(arg);
      if (!/^-?\d{5,20}$/.test(gid)) return sendMessage(env, chatId, "فرمت درست: /set_group -1001234567890");
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('group_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(gid).run();
      await audit(env, userId, "set_group", gid);
      return sendMessage(env, chatId, "شناسه‌ی گروه ثبت شد.");
    }
    default:
      if (text_is_command(message.text)) return sendMessage(env, chatId, "دستور ناشناخته. /help رو بزن.");
      return; // پیام‌های عادی ادمین هم بی‌پاسخ
  }
}

function text_is_command(text) {
  return (text || "").trim().startsWith("/");
}
