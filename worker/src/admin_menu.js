import { tg } from "./telegram.js";

// منوی دکمه‌ای ادمین در پیوی. هر دکمه همان دستور متنی را اجرا می‌کند (هیچ منطق تازه‌ای ندارد).
// ترتیب این لیست بخشی از callback_data است (am:<اندیس>)؛ جابه‌جایی آن دکمه‌ها را عوض می‌کند.
export const ADMIN_MENU = [
  { label: "وضعیت ربات", cmd: "/status" },
  { label: "وضعیت ارسال", cmd: "/scrape_status" },
  { label: "توقف ارسال", cmd: "/scrape_pause", owner: true },
  { label: "ادامه ارسال", cmd: "/scrape_resume", owner: true },
  { label: "بررسی‌ها", cmd: "/review", owner: true },
  { label: "تغییرات", cmd: "/log" },
  { label: "گزارش اسکرپ", cmd: "/scrape_log" },
  { label: "تعطیلات", cmd: "/holiday_list" },
  { label: "کلمات کلیدی", cmd: "/keyword_list" },
  { label: "جزوه‌ها", cmd: "/jozve_list" },
  { label: "شماره‌ها", cmd: "/call_list" },
  { label: "افزودن شماره", cmd: "/call_add" },
  { label: "لینک‌ها", cmd: "/link_list" },
  { label: "افزودن لینک", cmd: "/link_add" },
  { label: "رویدادها", cmd: "/event_list" },
  { label: "افزودن رویداد", cmd: "/event_add" },
  { label: "پشتیبان", cmd: "/backup" },
  { label: "ادمین‌ها", cmd: "/admins", owner: true },
  { label: "راهنما", cmd: "/help" },
];

// دکمه‌های مخصوص مالک برای ادمین‌های دیگه نشون داده نمی‌شن
export async function adminMenu(env, chatId, userId, isOwnerUser) {
  const rows = [];
  let row = [];
  ADMIN_MENU.forEach((item, i) => {
    if (item.owner && !isOwnerUser) return;
    row.push({ text: item.label, callback_data: `am:${i}` });
    if (row.length === 2) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  return tg(env, "sendMessage", { chat_id: chatId, text: "منوی ادمین:", reply_markup: { inline_keyboard: rows } });
}
