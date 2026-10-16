const FIXED = Date.parse("2026-10-14T08:30:00Z"); // ۱۲:۰۰ تهران
const realNow = Date.now;
Date.now = () => FIXED + (realNow() - realNow()); // ثابت
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } };
