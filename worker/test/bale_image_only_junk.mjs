// ورکر: پست بله‌ی تصویری بدون کپشن جنک نیست؛ پست بدون عکس و بدون متن جنک است.
const WORKER = new URL("..", import.meta.url);
const { isJunkBalePost } = await import(new URL("src/channels.js", WORKER).href);

let fails = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };

ok("image-only post is not junk", isJunkBalePost({ image_url: "https://x/a.jpg", text: "" }) === false);
ok("image-only with footer text is not junk", isJunkBalePost({ image_url: "https://x/a.jpg", text: "۱۴:۳۰" }) === false);
ok("empty post without image is junk", isJunkBalePost({ image_url: "", text: "" }) === true);
ok("footer-only post without image is junk", isJunkBalePost({ image_url: "", text: "۴۱ ۷:۴۳" }) === true);
ok("text post without image is not junk", isJunkBalePost({ image_url: "", text: "کلاس فردا تشکیل نمی‌شود" }) === false);

console.log(fails ? `FAILED ${fails}` : "ALL PASSED");
process.exit(fails ? 1 : 0);
