// Creates .env with a random PROXY_API_KEY (32 random bytes, base64url) and mode 0600.
// Based on devteapot/codex-cursor-proxy scripts/init.mjs (MIT).
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(".env");
const key = randomBytes(32).toString("base64url");
const contents = ["# Created by npm run init. Keep this file private.", `PROXY_API_KEY=${key}`, "HOST=127.0.0.1", "PORT=8787", ""].join("\n");
try {
  await writeFile(path, contents, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  console.log("Created .env (mode 0600) with a new PROXY_API_KEY.");
  console.log("Show the key when you need it for Cursor: grep PROXY_API_KEY .env");
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.error(".env already exists; refusing to overwrite it.");
  process.exitCode = 1;
}
