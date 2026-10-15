// قضاوت خروجی هر مجموعه تست. هر دو شرط لازم‌اند: exit صفر و نبود خط FAIL.
// quiet_all یک بررسی ویژه هم دارد: تعداد و نوع خطوط باید کامل باشد (خروجی ناقص = شکست).
export const QUIET_EXPECTED = { group: 8, dm: 2 };

export function judgeSuite(name, status, out) {
  if (status !== 0) return { ok: false, reason: `exit=${status}` };
  if (/^FAIL/m.test(out)) return { ok: false, reason: "FAIL line" };
  if (name === "quiet_all.mjs") {
    const lines = out.split("\n").filter((l) => /→/.test(l));
    const group = lines.filter((l) => /^\d+:\d+ \| group /.test(l));
    const dm = lines.filter((l) => /^\d+:\d+ \| DM /.test(l));
    if (group.length !== QUIET_EXPECTED.group || dm.length !== QUIET_EXPECTED.dm) return { ok: false, reason: `incomplete: group ${group.length}/${QUIET_EXPECTED.group}, dm ${dm.length}/${QUIET_EXPECTED.dm}` };
    if (!group.every((l) => /→ silent/.test(l))) return { ok: false, reason: "group answered in quiet hours" };
    if (!dm.every((l) => /→ answered/.test(l))) return { ok: false, reason: "DM not answered" };
  }
  return { ok: true, reason: "" };
}
