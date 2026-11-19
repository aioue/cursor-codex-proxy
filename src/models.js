import { readFile } from "node:fs/promises";
import { silentLogger } from "./log.js";

// Last-resort list when neither the live catalog nor the CLI's models cache is
// available. gpt-5.5 is from the task brief; the gpt-5.6-* names are from
// devteapot's .env.example (2026-08). None of these were verified against the
// live catalog. Override with CODEX_PROXY_MODELS.
export const BUILTIN_MODELS = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const LIVE_TTL_MS = 5 * 60 * 1000;

function idsFromCatalog(payload) {
  const models = Array.isArray(payload) ? payload : payload?.models ?? payload?.data;
  if (!Array.isArray(models)) return [];
  return models
    .filter((model) => model && typeof model === "object")
    .filter((model) => model.supported_in_api !== false)
    .filter((model) => model.visibility === undefined || model.visibility === "list")
    .map((model, order) => ({ id: model.slug || model.id || model.model, priority: Number.isFinite(model.priority) ? model.priority : 0, order }))
    .filter((model) => typeof model.id === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(model.id))
    .sort((a, b) => b.priority - a.priority || a.order - b.order)
    .map((model) => model.id);
}

// Source order: live catalog (cached 5 min) -> the CLI's models_cache.json ->
// BUILTIN_MODELS. `source` is one of "configured" | "live" | "cache" | "builtin"
// and goes into the x-codex-proxy-models-source header. File paths never leave
// this module.
export class ModelCatalog {
  #live = null;

  constructor({ upstream, cacheFile, configuredModels = [], variants = [], now = Date.now, logger = silentLogger }) {
    this.upstream = upstream;
    this.cacheFile = cacheFile;
    this.configuredModels = configuredModels;
    this.variants = variants;
    this.now = now;
    this.logger = logger;
  }

  async #baseIds(signal) {
    if (this.configuredModels.length) return { ids: this.configuredModels, source: "configured" };
    if (this.#live && this.now() - this.#live.at < LIVE_TTL_MS) return { ids: this.#live.ids, source: "live" };
    try {
      const ids = idsFromCatalog(await this.upstream.listModels(signal));
      if (ids.length) {
        this.#live = { ids, at: this.now() };
        return { ids, source: "live" };
      }
    } catch (error) {
      this.logger.warn("live model catalog unavailable; falling back", { code: error?.code ?? error?.name });
    }
    if (this.cacheFile) {
      try {
        const ids = idsFromCatalog(JSON.parse(await readFile(this.cacheFile, "utf8")));
        if (ids.length) return { ids, source: "cache" };
      } catch {
        // missing or unreadable cache: fall through
      }
    }
    return { ids: BUILTIN_MODELS, source: "builtin" };
  }

  async list(signal) {
    const { ids, source } = await this.#baseIds(signal);
    const all = [];
    for (const id of ids) {
      all.push(id);
      for (const variant of this.variants) all.push(`${id}-${variant}`);
    }
    return {
      source,
      body: {
        object: "list",
        data: Array.from(new Set(all)).map((id) => ({ id, object: "model", created: 0, owned_by: "openai" }))
      }
    };
  }
}
