import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { createLogger, sanitize } from "../src/log.js";
import { jwt } from "./helpers.js";

test("sanitize strips C0, DEL, C1, ANSI and Unicode line separators", () => {
  const dirty = "a\nb\r\x1b[31mred\x1b[0m\x07\x7f\x9b\u2028\u2029z";
  const clean = sanitize(dirty);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.match(clean, /^a b .*red.*z$/);
});

test("sanitize redacts bearer tokens, JWTs and the home directory", () => {
  const token = jwt({ sub: "user" });
  const clean = sanitize(`Bearer abc.def-123 then ${token} at ${homedir()}/.codex/auth.json`);
  assert.doesNotMatch(clean, /abc\.def-123/);
  assert.ok(!clean.includes(token));
  assert.ok(!clean.includes(homedir()));
  assert.match(clean, /~\/\.codex\/auth\.json/);
});

test("logger sanitises message and every field key and value", () => {
  const lines = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info("hello\nforged [proxy] line", { "mo\ndel": "gpt\r\n[proxy] fake", n: 3 });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[\r\n]/);
  assert.match(lines[0], /n=3/);
});

test("sanitize truncates long values", () => {
  assert.ok(sanitize("x".repeat(1000), 50).length <= 51);
});
