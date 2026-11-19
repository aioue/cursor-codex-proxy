import { randomUUID } from "node:crypto";
import { REASONING_EFFORTS } from "./config.js";
import { HttpError, UpstreamStreamError } from "./errors.js";

const DEFAULT_INSTRUCTIONS = "You are a coding assistant. Follow the supplied user instructions and tool definitions.";
const TIER_SUFFIXES = { fast: "priority", priority: "priority" };
// Request fields forwarded upstream after conversion. Everything else
// (stream_options, store, temperature, max_tokens, prompt_cache_options, user,
// client_metadata, metadata, response_format, ...) is dropped: the Codex backend
// rejects several of them, and the rest have no Codex equivalent.
const KNOWN_DROPPED = new Set([
  "stream_options", "store", "temperature", "top_p", "max_tokens", "max_completion_tokens",
  "max_output_tokens", "prompt_cache_options", "user", "client_metadata", "metadata",
  "response_format", "n", "presence_penalty", "frequency_penalty", "logprobs", "top_logprobs",
  "seed", "stop", "service_tier", "reasoning_effort", "truncation", "previous_response_id",
  "safety_identifier", "logit_bias", "modalities", "audio", "prediction", "web_search_options"
]);

// ---------- model id suffixes ----------

// "gpt-5.5-high" -> { model: "gpt-5.5", effort: "high" }
// "gpt-5.5-xhigh-fast" -> { model: "gpt-5.5", effort: "xhigh", serviceTier: "priority" }
// Only the last two dash-separated tokens are inspected, and the base must stay non-empty.
export function parseModelId(id) {
  const parts = String(id).split("-");
  let effort;
  let serviceTier;
  for (let i = 0; i < 2 && parts.length > 1; i += 1) {
    const last = parts.at(-1).toLowerCase();
    if (!serviceTier && TIER_SUFFIXES[last]) {
      serviceTier = TIER_SUFFIXES[last];
      parts.pop();
    } else if (!effort && REASONING_EFFORTS.includes(last)) {
      effort = last;
      parts.pop();
    } else {
      break;
    }
  }
  return { model: parts.join("-"), effort, serviceTier };
}

// ---------- content conversion ----------

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .filter((part) => ["text", "input_text", "output_text"].includes(part?.type))
    .map((part) => part.text ?? "")
    .join("\n");
}

function imagePart(part) {
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  if (typeof url !== "string" || !url) return null;
  const detail = part.detail ?? part.image_url?.detail;
  return { type: "input_image", image_url: url, ...(["low", "high", "auto"].includes(detail) ? { detail } : {}) };
}

function contentParts(content, role) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [{ type: textType, text: textFromContent(content) }];

  const converted = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (["text", "input_text", "output_text"].includes(part.type)) {
      converted.push({ type: textType, text: part.text ?? "" });
    } else if (role === "assistant" && part.type === "refusal") {
      converted.push({ type: "refusal", refusal: part.refusal ?? "" });
    } else if (role !== "assistant" && (part.type === "image_url" || part.type === "input_image")) {
      const image = part.type === "input_image" && part.file_id ? { type: "input_image", file_id: part.file_id } : imagePart(part);
      if (image) converted.push(image);
    } else if (role !== "assistant" && part.type === "input_file") {
      converted.push(part);
    }
  }
  return converted.length ? converted : [{ type: textType, text: "" }];
}

function stringifyOutput(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    // Responses accepts content arrays for tool output; normalise text/image parts.
    return output.map((part) => (part?.type === "image_url" ? imagePart(part) : part)).filter(Boolean);
  }
  return output == null ? "" : JSON.stringify(output);
}

// ---------- tools ----------

// Chat Completions nests function tools ({type, function: {name, ...}}); Responses
// wants them flat ({type, name, ...}). Cursor sends the nested form even inside
// Responses-shaped bodies. `custom` tools (Cursor's grammar-based ApplyPatch) pass
// through. Other tool types are dropped.
export function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    let flat;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      const fn = tool.function;
      flat = {
        type: "function",
        name: fn.name,
        description: fn.description ?? "",
        parameters: fn.parameters ?? { type: "object", properties: {} },
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {})
      };
    } else if (tool.type === "function" && typeof tool.name === "string") {
      flat = {
        type: "function",
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {})
      };
    } else if (tool.type === "custom" && typeof tool.name === "string") {
      flat = {
        type: "custom",
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.format ? { format: tool.format } : {})
      };
    }
    if (!flat || typeof flat.name !== "string" || !flat.name || seen.has(flat.name)) continue;
    seen.add(flat.name);
    out.push(flat);
  }
  return out.length ? out : undefined;
}

function convertToolChoice(choice) {
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (choice && typeof choice === "object") {
    const name = choice.function?.name ?? choice.name;
    if ((choice.type === "function" || choice.type === "custom") && typeof name === "string") {
      return { type: choice.type, name };
    }
  }
  return "auto";
}

// ---------- messages -> input ----------

function messagesToInput(messages, instructions) {
  const input = [];
  for (const message of messages) {
    const role = message?.role;
    if (role === "system") {
      const text = textFromContent(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
        throw new HttpError(400, "A tool message is missing tool_call_id.", "invalid_tool_message");
      }
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: stringifyOutput(textFromContent(message.content)) });
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "developer") continue;

    const hasContent = message.content != null && !(typeof message.content === "string" && message.content === "" && message.tool_calls);
    if (hasContent) input.push({ type: "message", role, content: contentParts(message.content, role) });
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.type !== "function" || !call.function?.name) continue;
        input.push({
          type: "function_call",
          call_id: call.id || `call_${randomUUID().replaceAll("-", "")}`,
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {})
        });
      }
    }
  }
  return input;
}

// ---------- Responses-shaped input normalisation ----------

function normaliseInput(rawInput, instructions) {
  if (typeof rawInput === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: rawInput }] }];
  }
  if (!Array.isArray(rawInput)) throw new HttpError(400, "input must be a string or an array.", "invalid_input");
  const input = [];
  for (const item of rawInput) {
    if (!item || typeof item !== "object") continue;
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      if (item.role === "system") {
        const text = textFromContent(item.content);
        if (text) instructions.push(text);
        continue;
      }
      if (!["user", "assistant", "developer"].includes(item.role)) continue;
      input.push({ type: "message", role: item.role, content: contentParts(item.content, item.role) });
    } else if (type === "function_call" || type === "custom_tool_call") {
      input.push(item);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string" || !item.call_id) {
        throw new HttpError(400, `A ${type} item is missing call_id.`, "invalid_tool_message");
      }
      input.push({ ...item, output: stringifyOutput(item.output) });
    } else if (type === "reasoning") {
      input.push(item);
    }
    // Other item types (item_reference, web_search_call, ...) are dropped.
  }
  return input;
}

// ---------- entry point ----------

// Accepts both Cursor wire formats on /v1/chat/completions:
//   * classic Chat Completions ({ messages: [...] })
//   * Responses-shaped bodies ({ input: [...] }) that Cursor sends for Codex models
// and produces a body for chatgpt.com/backend-api/codex/responses.
export function toResponsesRequest(body, { defaultReasoningEffort = "medium", defaultServiceTier } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.", "invalid_body");
  }
  if (typeof body.model !== "string" || !body.model) throw new HttpError(400, "The model field is required.", "model_required");

  const instructions = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) instructions.push(body.instructions);

  let wireFormat;
  let input;
  if (Array.isArray(body.messages) && body.input === undefined) {
    wireFormat = "messages";
    input = messagesToInput(body.messages, instructions);
  } else if (body.input !== undefined) {
    wireFormat = "input";
    input = normaliseInput(body.input, instructions);
  } else {
    throw new HttpError(400, "Either messages or input is required.", "input_required");
  }
  if (input.length === 0) throw new HttpError(400, "The request contains no user, assistant or tool content.", "input_empty");

  const suffix = parseModelId(body.model);
  const requestedEffort = body.reasoning?.effort ?? body.reasoning_effort;
  const effort = suffix.effort
    ?? (REASONING_EFFORTS.includes(requestedEffort) ? requestedEffort : undefined)
    ?? defaultReasoningEffort;
  const summary = ["auto", "concise", "detailed", "none"].includes(body.reasoning?.summary) ? body.reasoning.summary : "auto";
  // Client-sent service_tier is ignored on purpose: priority spends quota faster,
  // so it is opt-in only through the model suffix or DEFAULT_SERVICE_TIER.
  const serviceTier = suffix.serviceTier ?? defaultServiceTier;

  const promptCacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key
    ? body.prompt_cache_key
    : typeof body.user === "string" && body.user
      ? body.user
      : undefined;

  const tools = convertTools(body.tools);
  const request = {
    model: suffix.model,
    instructions: instructions.join("\n\n") || DEFAULT_INSTRUCTIONS,
    input,
    ...(tools ? { tools } : {}),
    tool_choice: convertToolChoice(body.tool_choice),
    parallel_tool_calls: body.parallel_tool_calls !== false,
    reasoning: { effort, summary },
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey.slice(0, 256) } : {}),
    ...(body.text && typeof body.text === "object" && !Array.isArray(body.text) ? { text: body.text } : {}),
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"]
  };

  const handled = new Set(["model", "messages", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "prompt_cache_key", "text", "stream", "include"]);
  const dropped = Object.keys(body).filter((key) => !handled.has(key));
  const meta = {
    wireFormat,
    model: suffix.model,
    effort,
    serviceTier,
    stream: body.stream === true,
    // Only names from a fixed list are reported; unknown names are counted, never echoed.
    droppedKnown: dropped.filter((key) => KNOWN_DROPPED.has(key)),
    droppedUnknown: dropped.filter((key) => !KNOWN_DROPPED.has(key)).length
  };
  return { request, meta };
}

// ---------- Responses events -> Chat Completions ----------

function usageFromResponse(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completion = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens ?? prompt + completion,
    ...(Number.isFinite(cached) ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(Number.isFinite(reasoning) ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {})
  };
}

function errorFromEvent(event) {
  const error = event?.response?.error ?? event?.error ?? event;
  const code = typeof error?.code === "string" ? error.code : typeof error?.type === "string" ? error.type : "upstream_stream_error";
  const message = typeof error?.message === "string" ? error.message : "The upstream response failed.";
  return new UpstreamStreamError(message, code);
}

const INCOMPLETE_FINISH = { max_output_tokens: "length", content_filter: "content_filter" };

// Converts Codex Responses SSE events into Chat Completions chunks. consume()
// returns the chunks to send for one event and throws UpstreamStreamError for
// terminal failures, so callers can turn them into a proper error instead of
// silently cutting the stream off.
export class ChatCompletionState {
  constructor(model) {
    this.id = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.content = "";
    this.toolCalls = [];
    this.byItem = new Map();
    this.started = false;
    this.completed = false;
    this.usage = undefined;
    this.finishReason = "stop";
  }

  chunk(delta, finishReason = null) {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
  }

  usageChunk() {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: this.usage };
  }

  #role(chunks) {
    if (!this.started) {
      this.started = true;
      chunks.push(this.chunk({ role: "assistant", content: "" }));
    }
  }

  #toolIndex(event) {
    for (const key of [event.item_id, event.call_id]) {
      if (key !== undefined && this.byItem.has(key)) return this.byItem.get(key);
    }
    return undefined;
  }

  #startTool(item, chunks) {
    const key = item.id || item.call_id;
    if (key && this.byItem.has(key)) return this.byItem.get(key);
    const index = this.toolCalls.length;
    const initial = item.type === "custom_tool_call" ? item.input ?? "" : item.arguments ?? "";
    const call = {
      id: item.call_id || item.id || `call_${randomUUID().replaceAll("-", "")}`,
      type: "function",
      function: { name: item.name || "", arguments: initial }
    };
    this.toolCalls.push(call);
    if (item.id) this.byItem.set(item.id, index);
    if (item.call_id) this.byItem.set(item.call_id, index);
    this.finishReason = "tool_calls";
    chunks.push(this.chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: initial } }] }));
    return index;
  }

  consume(event) {
    const chunks = [];
    const type = event?.type;
    if (typeof event?.response?.id === "string") this.id = event.response.id;
    // this.model stays the id the client asked for (e.g. "gpt-5.5-high"), not the
    // upstream base model, so the client sees the model it selected.

    if (type === "response.failed" || type === "error") throw errorFromEvent(event);

    this.#role(chunks);

    if (type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        this.content += delta;
        chunks.push(this.chunk({ content: delta }));
      }
    } else if (type === "response.output_item.added" && ["function_call", "custom_tool_call"].includes(event.item?.type)) {
      this.#startTool(event.item, chunks);
    } else if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
      let index = this.#toolIndex(event);
      if (index === undefined) index = Math.max(0, this.toolCalls.length - 1);
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (this.toolCalls[index] && delta) {
        this.toolCalls[index].function.arguments += delta;
        chunks.push(this.chunk({ tool_calls: [{ index, function: { arguments: delta } }] }));
      }
    } else if (type === "response.output_item.done" && ["function_call", "custom_tool_call"].includes(event.item?.type)) {
      // Some streams deliver arguments only on .done; send whatever was not streamed.
      const index = this.#startTool(event.item, chunks);
      const full = event.item.type === "custom_tool_call" ? event.item.input : event.item.arguments;
      const call = this.toolCalls[index];
      if (typeof full === "string" && full.startsWith(call.function.arguments) && full.length > call.function.arguments.length) {
        const rest = full.slice(call.function.arguments.length);
        call.function.arguments = full;
        chunks.push(this.chunk({ tool_calls: [{ index, function: { arguments: rest } }] }));
      }
    } else if (type === "response.completed") {
      this.completed = true;
      this.usage = usageFromResponse(event.response);
      chunks.push(this.chunk({}, this.finishReason));
      if (this.usage) chunks.push(this.usageChunk());
    } else if (type === "response.incomplete") {
      const reason = event.response?.incomplete_details?.reason;
      const finish = INCOMPLETE_FINISH[reason];
      if (!finish) throw new UpstreamStreamError(`The upstream response was incomplete (${typeof reason === "string" ? reason : "unknown reason"}).`, "response_incomplete");
      this.completed = true;
      this.finishReason = this.finishReason === "tool_calls" ? "tool_calls" : finish;
      this.usage = usageFromResponse(event.response);
      chunks.push(this.chunk({}, this.finishReason));
      if (this.usage) chunks.push(this.usageChunk());
    }
    return chunks;
  }

  finish() {
    if (!this.completed) throw new UpstreamStreamError("The upstream stream ended before the response completed.", "upstream_truncated");
  }

  completion() {
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: this.content || null,
          ...(this.toolCalls.length ? { tool_calls: this.toolCalls } : {})
        },
        finish_reason: this.finishReason
      }],
      ...(this.usage ? { usage: this.usage } : {})
    };
  }
}

export const translateInternals = { contentParts, messagesToInput, normaliseInput, usageFromResponse, convertToolChoice };
