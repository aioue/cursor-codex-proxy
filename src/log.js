import { homedir } from "node:os";

// Everything that reaches a log line goes through sanitize(). Client-controlled
// values (model ids, field names) and upstream error text could otherwise carry
// ANSI escapes or newlines that forge log lines or rewrite the terminal.
// C0, DEL, C1, and the Unicode line/paragraph separators are all removed.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
// Belt and braces: the proxy never passes tokens to the logger, but if an
// upstream error echoes one back it must not reach disk.
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

export function sanitize(value, maxLength = 300) {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text.replace(CONTROL, " ").replace(BEARER, "Bearer [redacted]").replace(JWT, "[redacted-jwt]");
  const home = homedir();
  if (home && home.length > 1) text = text.split(home).join("~");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function formatFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${sanitize(key, 40)}=${sanitize(value, 120)}`)
    .join(" ");
}

export function createLogger(sink = (line) => process.stderr.write(`${line}\n`)) {
  const write = (level, message, fields) => {
    const tail = formatFields(fields);
    sink(`[proxy] ${level} ${sanitize(message)}${tail ? ` ${tail}` : ""}`);
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields)
  };
}

export const silentLogger = { info() {}, warn() {}, error() {} };
