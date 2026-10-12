// منطق خالص جدول مترو: خواندن فایل xlsx، اعتبارسنجی، و پیدا کردن سرویس‌های یک مسیر.
// زمان‌ها در دیتابیس به دقیقه از نیمه‌شب ذخیره می‌شن.
import { parseXlsx } from "./xlsx.js";

export const KIND_LABEL = { regular: "روزهای عادی", friday: "جمعه و تعطیلات رسمی" };
const KIND_BY_LABEL = { "روزهای عادی": "regular", "جمعه و تعطیلات رسمی": "friday" };
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// کلید مقایسه‌ی نام: فاصله و ZWNJ حذف می‌شن (فقط برای تطبیق، نه نمایش)
const key = (s) => String(s ?? "").replace(/[‌‍‎‏\s]/g, "");
const fail = (msg) => {
  throw new Error(msg);
};

function cellMinutes(v, where) {
  if (v === "" || v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v >= 1) fail(`مقدار زمان نامعتبر در ${where}`);
  return Math.round(v * 1440) % 1440;
}

export async function parseMetroWorkbook(buf) {
  let wb;
  try {
    wb = await parseXlsx(buf);
  } catch {
    fail("فایل xlsx قابل خواندن نیست.");
  }

  let label = "";
  for (const s of wb.sheets) {
    for (const r of s.rows) {
      if (key(r[0]) === "نوعبرنامه") label = String(r[1] ?? "").trim();
    }
  }
  const kind = KIND_BY_LABEL[label];
  if (!kind) fail("«نوع برنامه» در شیت راهنما شناخته نشد.");

  const dirs = wb.sheets.filter((s) => s.name.trim().startsWith("به سمت"));
  if (!dirs.length) fail("هیچ شیتی با نام «به سمت …» پیدا نشد.");

  const header0 = dirs[0].rows[0] || [];
  if (key(header0[0]) !== "سرویس") fail("ستون اول شیت جهت باید «سرویس» باشه.");
  const stations = header0.slice(1).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (stations.length < 3) fail("تعداد ایستگاه‌ها خیلی کمه.");
  if (new Set(stations.map(key)).size !== stations.length) fail("نام ایستگاه‌ها تکراریه.");

  const sheets = [];
  for (const s of dirs) {
    const hk = (s.rows[0] || []).map(key);
    const cols = stations.map((n) => hk.indexOf(key(n)));
    if (cols.some((c) => c < 0)) fail(`ایستگاه‌های شیت «${s.name.trim()}» با شیت اول یکی نیست.`);

    const trains = [];
    s.rows.slice(1).forEach((r, idx) => {
      if (!r || r.every((v) => v === "" || v === null || v === undefined)) return;
      const row = idx + 2;
      if (typeof r[0] !== "number" || !Number.isInteger(r[0])) fail(`شماره سرویس نامعتبر در ردیف ${row}`);
      const t = cols.map((c) => cellMinutes(r[c], `ردیف ${row}`));
      if (t.filter((x) => x !== null).length < 2) fail(`ردیف ${row} کمتر از دو ایستگاه زمان دارد.`);
      trains.push({ s: r[0], t });
    });
    if (!trains.length) fail(`شیت «${s.name.trim()}» سرویسی نداره.`);
    sheets.push({ name: s.name.trim(), trains });
  }

  return { v: 1, kind, stations, sheets };
}

export function summarize(data) {
  let lo = Infinity;
  let hi = -Infinity;
  let total = 0;
  for (const sh of data.sheets) {
    total += sh.trains.length;
    for (const tr of sh.trains) {
      for (const m of tr.t) {
        if (m === null) continue;
        lo = Math.min(lo, m);
        hi = Math.max(hi, m);
      }
    }
  }
  return {
    stations: data.stations.length,
    sheets: data.sheets.map((s) => ({ name: s.name, count: s.trains.length })),
    total,
    first: lo,
    last: hi,
  };
}

// سرویس‌هایی که از ایستگاه i به j می‌رن: زمان حرکت از i باید قبل از رسیدن به j باشه.
// جهت از روی زمان‌ها تعیین می‌شه، نه نام شیت.
export function tripsFor(data, i, j, nowMin, limit = 3) {
  const all = [];
  for (const sh of data.sheets) {
    for (const tr of sh.trains) {
      const dep = tr.t[i];
      const arr = tr.t[j];
      if (dep == null || arr == null || !(dep < arr)) continue;
      all.push({ s: tr.s, dep, arr });
    }
  }
  all.sort((a, b) => a.dep - b.dep);
  const upcoming = all.filter((t) => t.dep >= nowMin).slice(0, limit);
  return { total: all.length, upcoming };
}

const pad = (n) => String(n).padStart(2, "0");
export const minToHM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const fa2 = (x) => String(x).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
