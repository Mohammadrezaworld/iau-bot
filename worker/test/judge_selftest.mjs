// آزمون منفی قضاوت: خروجی بد باید شکست بخوره. اگه این تست پاس شد، runner معتبره.
import { judgeSuite } from "./judge.mjs";
let bad = 0;
const expect = (label, got, want) => { const ok = got === want; console.log((ok ? "PASS " : "FAIL ") + label); if (!ok) bad += 1; };
const goodQuiet = [
  ...Array.from({ length: 8 }, (_, i) => `0${i}:00 | group /x${i} → silent `),
  "0:00 | DM /start (user) → answered x", "0:00 | DM /menu (owner) → answered ",
].join("\n");
expect("selftest: good quiet output passes", judgeSuite("quiet_all.mjs", 0, goodQuiet).ok, true);
expect("selftest: exit 7 with good lines FAILS", judgeSuite("quiet_all.mjs", 7, goodQuiet).ok, false);
expect("selftest: missing line FAILS", judgeSuite("quiet_all.mjs", 0, goodQuiet.split("\n").slice(1).join("\n")).ok, false);
expect("selftest: group answered FAILS", judgeSuite("quiet_all.mjs", 0, goodQuiet.replace("silent", "ANSWERED")).ok, false);
expect("selftest: FAIL line FAILS", judgeSuite("batch_approval.mjs", 0, "PASS a\nFAIL b").ok, false);
expect("selftest: plain suite exit 0 passes", judgeSuite("batch_approval.mjs", 0, "PASS a").ok, true);
console.log(bad ? `${bad} selftest(s) FAILED` : "judge selftest ok");
process.exit(bad ? 1 : 0);
