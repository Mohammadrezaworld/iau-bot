import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/scrape-telegram.yml"), "utf8");

assert.doesNotMatch(workflow, /^[ \t]*schedule[ \t]*:/m, "Telegram workflow must not have a schedule trigger");
console.log("PASS internal schedule trigger is absent");

assert.match(workflow, /^[ \t]*workflow_dispatch[ \t]*:/m, "Telegram workflow must retain manual dispatch");
console.log("PASS manual workflow_dispatch trigger remains");
