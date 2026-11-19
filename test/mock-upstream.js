import { once } from "node:events";
import { createServer } from "node:http";
import { okStream } from "./helpers.js";

// A stand-in for chatgpt.com/backend-api, bound to 127.0.0.1 on an ephemeral port.
// Records every request so tests can check headers and bodies.
export async function startMockUpstream(handlers = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const record = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(record);
    const path = new URL(req.url, "http://x").pathname;
    const handler = handlers[path];
    if (handler) return handler(req, res, record);
    if (path.endsWith("/codex/responses")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(okStream());
    }
    if (path.endsWith("/codex/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [
        { slug: "gpt-live-b", priority: 1, visibility: "list" },
        { slug: "gpt-live-a", priority: 5, visibility: "list" },
        { slug: "gpt-hidden", visibility: "hide" }
      ] }));
    }
    if (path.endsWith("/wham/usage")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ rate_limit: {
        primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 2000000000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 2000500000 }
      } }));
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    requests,
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/backend-api/codex`,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    }
  };
}
