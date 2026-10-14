// دستورهای ادمین در DM. کاربرهای عادی در DM هیچ پاسخی نمی‌گیرن.
import { sendMessage, sendJsonDocument, sendHtml } from "./telegram.js";
import { isAdmin, isOwner, audit, buildBackup, statusText, logText, getRole } from "./admin.js";
import { answerPublic, getSetting, sendCachedAnswer } from "./public.js";
import { parseDateInput, normalizeDigits } from "./jalali.js";
import { startWizard, handleWizardText, removeList } from "./wizard.js";
import { updatesText, flushPosts, scrapeCommand } from "./channels.js";
import { tg } from "./telegram.js";
import { faDate } from "./calendar.js";
import { handleManage, publicContacts, publicResources, publicEvents, MANAGE_HELP } from "./manage.js";
import { handleMetroDocument, metroInfoText, handleMetroCommand } from "./metro.js";
import { keywordCommand } from "./keywords.js";
import { holidayCommand } from "./holidays.js";
import { undoLast } from "./undo.js";
import { setQuietCommand } from "./channels.js";
import { editList } from "./wizard.js";
import { jozveListText, jozveRemoveList, jozveCategoryCommand, openDmMenu, dmIsMember, sendGate, DM_NOT_MEMBER } from "./jozve.js";
import { scrapeLogText } from "./monitor.js";

// دستورهایی که سطح content هم مجازه
const CONTENT_CMDS = new Set([
  "/start", "/help", "/cancel", "/ok", "/status",
  "/call", "/links", "/events", "/updates", "/menu", "/jozve", "/metro",
  "/call_add", "/call_edit", "/call_remove", "/call_list",
  "/link_add", "/link_edit", "/link_remove", "/link_list",
  "/event_add", "/event_remove", "/event_list",
  "/jozve_list", "/jozve_remove", "/jozve_category",
]);

export const PUBLIC_CMDS = ["/week", "/next", "/term", "/left", "/call", "/links", "/events", "/updates"];

export async function runPublic(env, chatId, cmd) {
  if (["/call"].includes(cmd)) {
    const html = await publicContacts(env);
    return sendCachedAnswer(env, chatId, "/call", html, async () => (await sendHtml(env, chatId, html)).message_id);
  }
  if (["/links"].includes(cmd)) {
    const text = await publicResources(env);
    return sendCachedAnswer(env, chatId, "/links", text, async () =>
      (await tg(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true })).message_id);
  }
  if (["/events"].includes(cmd)) return sendMessage(env, chatId, await publicEvents(env));
  if (["/updates"].includes(cmd)) return sendMessage(env, chatId, await updatesText(env));
  return answerPublic(env, chatId, cmd);
}

const DM_WELCOME = [
  "سلام، خوش اومدی.",
  "این ربات خدمات گروه رو اینجا، در پیوی، ارائه می‌ده تا گروه شلوغ نشه.",
  "",
  "جزوه‌ها و نمونه‌سوال‌ها",
  "از دکمه‌های زیر یا دستور /menu جزوه یا نمونه‌سوال رو انتخاب کن. بعد از دسته، درس و استاد، هر فایل یک دکمه‌ی لینک داره که مستقیم به پست کانال می‌ره.",
  "",
  "دستورهای دیگه:",
  "/call شماره‌های مفید",
  "/links لینک‌های مفید",
  "/events رویدادهای ترم",
  "",
  "تقویم ترم:",
  "/week هفته‌ی جاری (زوج یا فرد)",
  "/next هفته‌ی بعد",
  "/term فهرست هفته‌های ترم",
  "/left روزهای باقی‌مانده تا پایان کلاس‌ها",
  "",
  "جدول مترو",
  "/metro مبدا و مقصد و سرویس‌های بعدی",
].join("\n");

// پیام‌های پیوی کاربر عادی (ادمین‌ها به handleAdminMessage می‌رن). خدمات فقط برای اعضای گروه اصلی.
// بقیه‌ی پیام‌ها بی‌صدا نادیده گرفته می‌شن.
export async function handleDmUser(env, msg) {
  if (!msg.from || (await isAdmin(env, msg.from.id))) return false;
  const chatId = msg.chat.id;
  const uid = msg.from.id;
  const { cmd } = parseCmd(msg.text);
  if (cmd === "/start") {
    if (!(await dmIsMember(env, uid))) return sendGate(env, chatId, `${DM_WELCOME}\n\n${DM_NOT_MEMBER}`);
    // خوش‌آمد و دکمه‌های منو در یک پیام
    return openDmMenu(env, uid, DM_WELCOME, true);
  }
  if (cmd === "/jozve" || cmd === "/menu") return openDmMenu(env, uid);
  if (cmd === "/metro") {
    if (!(await dmIsMember(env, uid))) return sendGate(env, chatId, DM_NOT_MEMBER);
    return handleMetroCommand(env, msg);
  }
  // /updates در پیوی نیست: برای کاربر لازم نیست وضعیت بررسی کانال‌ها رو بخونه
  if (PUBLIC_CMDS.includes(cmd) && cmd !== "/updates") {
    if (!(await dmIsMember(env, uid))) return sendGate(env, chatId, DM_NOT_MEMBER);
    return runPublic(env, chatId, cmd);
  }
  return true;
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
  "/scrape_log — ۲۰ رویداد آخر اسکرپ (خطا، توقف و برگشت، ارسال به گروه)",
  "/bale_mode dry|live — حالت اسکرپ بله: آزمایشی (فقط گزارش) یا واقعی (ارسال)",
  "/backup — فایل پشتیبان",
  "/set_semester ۱۴۰۵-۰۶-۲۱ — شروع ترم (شنبه، شمسی)",
  "/set_group -100… — شناسه‌ی گروه",
  "/metro_info — جدول‌های مترو فعال",
  "/keyword_list — کلمات کلیدی اعلان کانال‌ها",
  "/keyword_add متن — افزودن کلمه‌ی کلیدی",
  "/keyword_remove [متن] — حذف کلمه‌ی کلیدی (بدون متن: لیست با دکمه)",
  "/jozve_list — تعداد جزوه‌ها به تفکیک درس و استاد",
  "/jozve_remove — حذف فایل از فهرست جزوه‌ها (با دکمه)",
  "/jozve_category — فهرست دسته‌ی درس‌ها؛ تعیین: /jozve_category درس | دسته",
  "جزوه: فایل رو توی کانال خصوصی جزوه‌ها بفرست، با کپشن: درس | استاد | عنوان",
  "/holiday_list — فهرست تعطیلات",
  "/holiday_add ۱۴۰۵/۱۰/۰۲ عنوان — افزودن تعطیلی",
  "/holiday_remove [تاریخ] — حذف تعطیلی (بدون تاریخ: لیست با دکمه)",
  "/set_quiet ۰۲-۰۶ — ساعت سکوت کانال‌ها (به وقت تهران)",
  "/scrape_pause — توقف ارسال پست‌های کانال‌ها به گروه (فقط مالک)",
  "/scrape_resume [all] — ادامه ارسال؛ پیش‌فرض: پست‌های معوق ارسال نشن، فقط جدیدها؛ all: معوق‌ها هم برن (فقط مالک)",
  "/scrape_status — وضعیت ارسال و تعداد پست‌های معوق",
  "/undo — برگشت آخرین تغییر کلمات، تعطیلات یا جدول مترو (۵ تغییر آخر)",
  "جدول مترو: فایل xlsx را همین‌جا در پیوی بفرست (فقط ادمین کامل)؛ پیش‌نمایش و تأیید دارد.",
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
  if (message.document) {
    if (role === "content") return sendMessage(env, chatId, "این کار برای سطح دسترسی شما نیست.");
    return handleMetroDocument(env, message);
  }
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
  // ادمین‌ها هم منوی شخصی و جدول مترو رو در پیوی دارن (همون مسیر کاربر عادی)
  if (cmd === "/menu" || cmd === "/jozve") return openDmMenu(env, userId);
  if (cmd === "/metro") return handleMetroCommand(env, message);

  // افزودن بدون آرگومان: مرحله‌به‌مرحله. حذف بدون آرگومان: لیست با دکمه
  const wizardFlows = { "/event_add": "event", "/call_add": "call", "/link_add": "link" };
  if (wizardFlows[cmd] && !arg) return startWizard(env, userId, chatId, wizardFlows[cmd]);
  const editTypes = { "/call_edit": "call", "/link_edit": "link" };
  if (editTypes[cmd] && !arg) return editList(env, chatId, editTypes[cmd]);
  const removeTypes = { "/event_remove": "event", "/call_remove": "call", "/link_remove": "link" };
  if (removeTypes[cmd] && !arg) return removeList(env, chatId, removeTypes[cmd]);

  const managed = await handleManage(env, userId, cmd, arg, `msg:${chatId}:${message.message_id}`);
  if (managed !== null) return sendMessage(env, chatId, managed);

  switch (cmd) {
    case "/start":
    case "/help":
      return sendMessage(env, chatId, HELP);
    case "/status":
      return sendMessage(env, chatId, await statusText(env));
    case "/bale_mode": {
      // فقط مالک: حالت اسکرپ بله؛ dry = آزمایشی (فقط گزارش)، live = واقعی (ارسال به گروه)
      if (!(await isOwner(env, userId))) return;
      const mode = String(arg || "").trim().toLowerCase();
      if (mode !== "dry" && mode !== "live") return sendMessage(env, chatId, "فرمت: /bale_mode dry یا /bale_mode live");
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('bale_dry_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(mode === "dry" ? "1" : "0").run();
      return sendMessage(env, chatId, mode === "dry" ? "بله: حالت آزمایشی (فقط گزارش به مالک)" : "بله: حالت واقعی (ارسال به گروه)");
    }
    case "/scrape_log":
      return sendMessage(env, chatId, await scrapeLogText(env));
    case "/jozve_list":
      return sendMessage(env, chatId, await jozveListText(env));
    case "/jozve_remove":
      return jozveRemoveList(env, chatId);
    case "/jozve_category":
      return jozveCategoryCommand(env, chatId, userId, arg);
    case "/holiday_list":
    case "/holiday_add":
    case "/holiday_remove":
      return holidayCommand(env, chatId, userId, cmd, arg);
    case "/undo":
      return sendMessage(env, chatId, await undoLast(env, userId));
    case "/set_quiet":
      return setQuietCommand(env, chatId, userId, arg);
    case "/scrape_pause":
    case "/scrape_resume":
    case "/scrape_status":
      return scrapeCommand(env, chatId, userId, cmd, arg, await isOwner(env, userId));
    case "/keyword_list":
    case "/keyword_add":
    case "/keyword_remove":
      return keywordCommand(env, chatId, userId, cmd, arg);
    case "/metro_info":
      return sendMessage(env, chatId, await metroInfoText(env));
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

