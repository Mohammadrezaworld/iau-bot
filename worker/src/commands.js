// دستورهای ادمین در DM. کاربرهای عادی در DM هیچ پاسخی نمی‌گیرن.
import { sendMessage, sendJsonDocument } from "./telegram.js";
import { isAdmin, audit, buildBackup, statusText, logText } from "./admin.js";

const HELP = [
  "دستورهای ادمین:",
  "/status — وضعیت ربات",
  "/log — ۲۰ تغییر آخر",
  "/backup — فایل پشتیبان",
  "/help — همین راهنما",
].join("\n");

export async function handleAdminMessage(env, message) {
  const chatId = message.chat.id;
  const userId = message.from && message.from.id;
  if (!userId) return;

  // کاربر عادی: بی‌صدا نادیده گرفته می‌شه
  if (!(await isAdmin(env, userId))) return;

  const text = (message.text || "").trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().split("@")[0];

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
    default:
      if (text.startsWith("/")) return sendMessage(env, chatId, "دستور ناشناخته. /help رو بزن.");
      return; // پیام‌های عادی ادمین هم بی‌پاسخ
  }
}

