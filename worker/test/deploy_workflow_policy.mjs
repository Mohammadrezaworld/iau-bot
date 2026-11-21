import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const deploy = readFileSync(resolve(root, ".github/workflows/deploy-worker.yml"), "utf8");
const prChecks = readFileSync(resolve(root, ".github/workflows/pr-checks.yml"), "utf8");

const triggerBlock = deploy.match(/^on:\r?\n([\s\S]*?)(?=^permissions:|^jobs:)/m)?.[1];
assert.ok(triggerBlock, "deploy workflow has a trigger block");
assert.deepEqual(
  [...triggerBlock.matchAll(/^  ([a-z][a-z0-9_-]*):/gm)].map((match) => match[1]),
  ["workflow_dispatch"],
  "production deploy has no automatic trigger"
);
assert.match(deploy, /^      confirm_production_deploy:\r?\n/m, "manual deploy has an explicit confirmation input");
assert.match(deploy, /^        required: true\r?\n/m, "confirmation input is required");
assert.match(deploy, /^        default: false\r?\n/m, "confirmation defaults to off");
assert.match(deploy, /^        type: boolean\r?\n/m, "confirmation is a boolean checkbox");
assert.match(deploy, /^    if: \$\{\{\s*inputs\.confirm_production_deploy\s*\}\}\s*$/m, "deploy job is gated by confirmation");
assert.match(deploy, /^permissions:\r?\n  contents: read\r?\n/m, "deploy workflow token is read-only");

assert.match(prChecks, /^on:\r?\n  pull_request:/m, "PR checks run on pull requests");
assert.doesNotMatch(prChecks, /pull_request_target|secrets\./, "PR checks do not use elevated triggers or secrets");
assert.match(prChecks, /^permissions:\r?\n  contents: read\r?\n/m, "PR workflow token is read-only");
assert.match(prChecks, /node-version: ["']22["']/, "PR checks use the documented Node 22+ test runtime");
assert.match(prChecks, /actions\/setup-python@v5/, "PR checks provision Python for scraper tests");
assert.match(prChecks, /python -m pip install httpx beautifulsoup4/, "PR checks install the existing scraper test dependencies");
assert.match(prChecks, /node worker\/test\/run\.mjs/, "PR checks run the complete regression suite");

console.log("PASS production deployment is manual-only and confirmation-gated");
console.log("PASS pull-request checks are read-only and run without secrets");
