import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSse } from "../src/sse.js";

// Fake, unsigned JWTs. Nothing here is a real credential.
export function jwt(payload) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

export async function tempAuth(tokens, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ccp-test-"));
  const authFile = join(dir, "auth.json");
  await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", ...extra, tokens }), { mode: 0o600 });
  return { dir, authFile };
}

export function sse(events) {
  return events.map((event) => encodeSse(event)).join("") + encodeSse("[DONE]");
}

export function okStream(text = "hello", usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 }) {
  return sse([
    { type: "response.created", response: { id: "resp_1", model: "gpt-test" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { id: "resp_1", usage } }
  ]);
}

export function captureLogger() {
  const lines = [];
  const push = (level) => (message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  return { lines, logger: { info: push("info"), warn: push("warn"), error: push("error") } };
}
