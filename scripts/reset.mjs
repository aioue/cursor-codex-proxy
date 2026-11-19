// Manual reset for the proxy's persisted guard state (README: "Kill switch").
//
//   npm run reset              clear the kill switch; keep the quota cooldown and daily counter
//   npm run reset -- --quota   also clear a usage-limit cooldown
//   npm run reset -- --all     delete the state file (kill switch, cooldown, daily counter)
//
// A running proxy re-reads the file on its next request while tripped, so no
// restart is needed. Only reset after you have checked the ChatGPT account and
// any email from OpenAI: the kill switch trips on policy and account errors.
// The state file holds codes, reasons and counters only; no tokens or content.
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { defaultStatePath } from "../src/config.js";
import { atomicWriteJson } from "../src/fsutil.js";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--quota", "--all"].includes(arg)) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}
const file = defaultStatePath(process.env);
const shown = file.startsWith(homedir()) ? `~${file.slice(homedir().length)}` : file;

let data;
try {
  data = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if (error?.code === "ENOENT") {
    console.log(`No state file at ${shown}; nothing to reset.`);
    process.exit(0);
  }
  if (!args.has("--all")) {
    console.error(`${shown} is not valid JSON. Run npm run reset -- --all to delete it.`);
    process.exit(1);
  }
  data = {};
}

if (args.has("--all")) {
  await unlink(file).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  console.log(`Deleted ${shown}.`);
  process.exit(0);
}

const cleared = [];
if (data.killSwitch) {
  cleared.push(`kill switch (${data.killSwitch.code}, tripped ${data.killSwitch.at})`);
  delete data.killSwitch;
}
if (args.has("--quota") && data.quotaUntil) {
  cleared.push(`quota cooldown (until ${new Date(data.quotaUntil).toISOString()})`);
  delete data.quotaUntil;
}
if (!cleared.length) {
  console.log("Nothing to reset: the kill switch is not tripped.");
  process.exit(0);
}
await atomicWriteJson(file, data);
console.log(`Cleared: ${cleared.join("; ")}. State file: ${shown}`);
