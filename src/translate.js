import { createHash, randomUUID } from "node:crypto";
import { REASONING_EFFORTS } from "./config.js";
import { HttpError, UpstreamStreamError } from "./errors.js";

const DEFAULT_INSTRUCTIONS = "You are a coding assistant. Follow the supplied user instructions and tool definitions.";
// Map, not an object literal: a lookup like TIER_SUFFIXES["__proto__"] or
// ["constructor"] on a plain object returns an inherited value, so a model id
// such as "gpt-5.5-constructor" used to be parsed as a service-tier suffix.
const TIER_SUFFIXES = new Map([["fast", "priority"], ["priority", "priority"]]);
const EFFORTS = new Set(REASONING_EFFORTS);
// Model ids end up in the x-codex-routing-hint header and the request body.
// This pattern excludes ";", "=", spaces, CR/LF and anything non-ASCII, so a
// client cannot append ";tier=priority" or a second header through the model id.
export const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
// Header-safe for session_id: visible ASCII with inner spaces, max 256.
const HEADER_SAFE_RE = /^[!-~](?:[ -~]{0,254}[!-~])?$/;
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
// Codex inserts the same placeholder for a tool call that never got an output
// (normalize.rs in openai/codex); the Responses API rejects unpaired calls.
const MISSING_OUTPUT = "aborted";

function shortHash(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return hash.digest("hex").slice(0, 24);
}

// Stable fallback for a missing call id: same history, same id, so the prompt
// prefix (and the upstream prompt cache) stays identical between turns.
function fallbackCallId(...parts) {
  return `call_${shortHash(...parts)}`;
}

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
    if (!serviceTier && TIER_SUFFIXES.has(last)) {
      serviceTier = TIER_SUFFIXES.get(last);
      parts.pop();
    } else if (!effort && EFFORTS.has(last)) {
      effort = last;
      parts.pop();
    } else {
      break;
    }
  }
  return { model: parts.join("-"), effort, serviceTier };
}

// prompt_cache_key doubles as the session_id header. A value that is not a
// valid header (CR/LF, non-Latin-1, too long) is replaced by a stable hash, so
// caching still works and `new Headers()` never throws on client input.
export function headerSafeKey(value) {
  if (typeof value !== "string" || !value) return undefined;
  return HEADER_SAFE_RE.test(value) ? value : `pck_${shortHash(value)}`;
}

// ---------- content conversion ----------

const TEXT_TYPES = new Set(["text", "input_text", "output_text"]);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .filter((part) => TEXT_TYPES.has(part?.type))
    .map((part) => part.text ?? "")
    .join("\n");
}

function imagePart(part) {
  if (part.type === "input_image" && typeof part.file_id === "string" && part.file_id) {
    return { type: "input_image", file_id: part.file_id, ...(["low", "high", "auto"].includes(part.detail) ? { detail: part.detail } : {}) };
  }
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  if (typeof url !== "string" || !url) return null;
  const detail = part.detail ?? part.image_url?.detail;
  return { type: "input_image", image_url: url, ...(["low", "high", "auto"].includes(detail) ? { detail } : {}) };
}

// Rebuilt from an allowlist, never forwarded as-is.
function filePart(part) {
  const out = { type: "input_file" };
  for (const key of ["file_id", "file_data", "file_url", "filename"]) {
    if (typeof part[key] === "string" && part[key]) out[key] = part[key];
  }
  return out.file_id || out.file_data || out.file_url ? out : null;
}

function contentParts(content, role) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [{ type: textType, text: textFromContent(content) }];

  const converted = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (TEXT_TYPES.has(part.type)) {
      converted.push({ type: textType, text: typeof part.text === "string" ? part.text : "" });
    } else if (role === "assistant" && part.type === "refusal") {
      converted.push({ type: "refusal", refusal: typeof part.refusal === "string" ? part.refusal : "" });
    } else if (role !== "assistant" && (part.type === "image_url" || part.type === "input_image")) {
      const image = imagePart(part);
      if (image) converted.push(image);
    } else if (role !== "assistant" && (part.type === "input_file" || part.type === "file")) {
      const file = filePart(part.file && typeof part.file === "object" ? part.file : part);
      if (file) converted.push(file);
    }
  }
  return converted.length ? converted : [{ type: textType, text: "" }];
}

// Tool results. Plain text stays a string (the common case, and what the CLI
// sends). When the result carries images, the Responses API accepts an array
// of input_text / input_image / input_file parts, so images are kept.
function toolOutput(output) {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (!Array.isArray(output)) return JSON.stringify(output);
  const parts = [];
  for (const part of output) {
    if (!part || typeof part !== "object") continue;
    if (TEXT_TYPES.has(part.type)) parts.push({ type: "input_text", text: typeof part.text === "string" ? part.text : "" });
    else if (part.type === "image_url" || part.type === "input_image") {
      const image = imagePart(part);
      if (image) parts.push(image);
    } else if (part.type === "input_file") {
      const file = filePart(part);
      if (file) parts.push(file);
    }
  }
  if (parts.every((part) => part.type === "input_text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function stringArg(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

// ---------- tools ----------

// Chat Grammar format ({type:"grammar", grammar:{syntax, definition}}) and the
// Responses one ({type:"grammar", syntax, definition}) differ; both are accepted
// and the Responses shape is sent.
function customFormat(format) {
  if (!format || typeof format !== "object") return undefined;
  if (format.type === "text") return { type: "text" };
  if (format.type === "grammar") {
    const grammar = format.grammar && typeof format.grammar === "object" ? format.grammar : format;
    if (typeof grammar.definition !== "string" || !["lark", "regex"].includes(grammar.syntax)) return undefined;
    return { type: "grammar", syntax: grammar.syntax, definition: grammar.definition };
  }
  return undefined;
}

// Chat Completions nests tools ({type:"function", function:{...}} and
// {type:"custom", custom:{name, format}}); Responses wants them flat. Cursor
// uses either shape in either body format. Other tool types are dropped.
// Returns the flat tools, a name -> kind map used to type tool calls in the
// history, and which custom shape the request used, so replies use the same one.
export function convertTools(tools) {
  const kinds = new Map();
  let customShape;
  if (!Array.isArray(tools) || tools.length === 0) return { tools: undefined, kinds, customShape };
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    let flat;
    if (tool.type === "function") {
      const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
      flat = {
        type: "function",
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {})
      };
    } else if (tool.type === "custom") {
      const nested = tool.custom && typeof tool.custom === "object";
      const def = nested ? tool.custom : tool;
      const format = customFormat(def.format);
      flat = {
        type: "custom",
        name: def.name,
        ...(typeof def.description === "string" && def.description ? { description: def.description } : {}),
        ...(format ? { format } : {})
      };
      if (typeof def.name === "string" && def.name) customShape ??= nested ? "nested" : "flat";
    }
    if (!flat || typeof flat.name !== "string" || !flat.name || kinds.has(flat.name)) continue;
    kinds.set(flat.name, flat.type);
    out.push(flat);
  }
  return { tools: out.length ? out : undefined, kinds, customShape };
}

function convertToolChoice(choice) {
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (choice && typeof choice === "object") {
    const name = choice.function?.name ?? choice.custom?.name ?? choice.name;
    if ((choice.type === "function" || choice.type === "custom") && typeof name === "string") {
      return { type: choice.type, name };
    }
  }
  return "auto";
}

function callItem(kind, callId, name, payload) {
  return kind === "custom"
    ? { type: "custom_tool_call", call_id: callId, name, input: payload }
    : { type: "function_call", call_id: callId, name, arguments: payload };
}

// Every call gets exactly one output of the matching type, and no output is
// sent without its call: the Responses API rejects both. Outputs whose call is
// missing are dropped; calls with no output get Codex's "aborted" placeholder.
function pairToolItems(input) {
  const calls = new Map();
  for (const item of input) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      calls.set(item.call_id, item.type === "custom_tool_call" ? "custom" : "function");
    }
  }
  const answered = new Set();
  const kept = [];
  let orphanOutputs = 0;
  for (const item of input) {
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const kind = calls.get(item.call_id);
      if (!kind || answered.has(item.call_id)) {
        orphanOutputs += 1;
        continue;
      }
      answered.add(item.call_id);
      kept.push({ type: kind === "custom" ? "custom_tool_call_output" : "function_call_output", call_id: item.call_id, output: item.output });
    } else {
      kept.push(item);
    }
  }
  const out = [];
  let missingOutputs = 0;
  for (const item of kept) {
    out.push(item);
    if ((item.type === "function_call" || item.type === "custom_tool_call") && !answered.has(item.call_id)) {
      answered.add(item.call_id);
      missingOutputs += 1;
      out.push({ type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: item.call_id, output: MISSING_OUTPUT });
    }
  }
  return { input: out, orphanOutputs, missingOutputs };
}

// System text before the first conversation turn becomes `instructions`. A
// system message later in the conversation stays in place as a developer
// message, so its position (and meaning) is kept.
function systemOrDeveloper(content, instructions, started, input) {
  if (!started) {
    const text = textFromContent(content);
    if (text) instructions.push(text);
    return;
  }
  input.push({ type: "message", role: "developer", content: contentParts(content, "developer") });
}

// ---------- messages -> input ----------

function messagesToInput(messages, instructions, kinds = new Map()) {
  const input = [];
  let started = false;
  messages.forEach((message, position) => {
    const role = message?.role;
    if (role === "system") {
      systemOrDeveloper(message.content, instructions, started, input);
      return;
    }
    if (role === "tool") {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
        throw new HttpError(400, "A tool message is missing tool_call_id.", "invalid_tool_message");
      }
      started = true;
      // The type is fixed up by pairToolItems from the matching call.
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: toolOutput(message.content) });
      return;
    }
    if (role !== "user" && role !== "assistant" && role !== "developer") return;
    started = true;

    const hasContent = message.content != null && !(typeof message.content === "string" && message.content === "" && message.tool_calls);
    if (hasContent) input.push({ type: "message", role, content: contentParts(message.content, role) });
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call, slot) => {
        if (!call || typeof call !== "object") return;
        let name;
        let payload;
        let kind;
        if (call.type === "custom" && call.custom && typeof call.custom === "object") {
          name = call.custom.name;
          payload = typeof call.custom.input === "string" ? call.custom.input : stringArg(call.custom.input);
          kind = "custom";
        } else if ((call.type === "function" || call.type === undefined) && call.function && typeof call.function === "object") {
          name = call.function.name;
          payload = stringArg(call.function.arguments);
          kind = kinds.get(name) === "custom" ? "custom" : "function";
        }
        if (typeof name !== "string" || !name) return;
        const callId = typeof call.id === "string" && call.id ? call.id : fallbackCallId(name, payload, position, slot);
        input.push(callItem(kind, callId, name, payload));
      });
    }
  });
  return input;
}

// ---------- Responses-shaped input normalisation ----------

// Every item is rebuilt from an allowlist. Item `id`s, `status` and unknown
// fields are dropped: with store:false the backend has no stored item to match
// an echoed id against and rejects the request.
function normaliseInput(rawInput, instructions, kinds = new Map()) {
  if (typeof rawInput === "string") {
    return { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: rawInput }] }], droppedItems: 0 };
  }
  if (!Array.isArray(rawInput)) throw new HttpError(400, "input must be a string or an array.", "invalid_input");
  const input = [];
  let droppedItems = 0;
  let started = false;
  rawInput.forEach((item, position) => {
    if (!item || typeof item !== "object") {
      droppedItems += 1;
      return;
    }
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      if (item.role === "system") {
        systemOrDeveloper(item.content, instructions, started, input);
        return;
      }
      if (!["user", "assistant", "developer"].includes(item.role)) {
        droppedItems += 1;
        return;
      }
      started = true;
      input.push({ type: "message", role: item.role, content: contentParts(item.content, item.role) });
    } else if (type === "function_call" || type === "custom_tool_call") {
      const name = item.name;
      if (typeof name !== "string" || !name) {
        droppedItems += 1;
        return;
      }
      started = true;
      const payload = type === "custom_tool_call"
        ? (typeof item.input === "string" ? item.input : stringArg(item.input))
        : stringArg(item.arguments);
      const kind = type === "custom_tool_call" || kinds.get(name) === "custom" ? "custom" : "function";
      const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : fallbackCallId(name, payload, position, 0);
      input.push(callItem(kind, callId, name, payload));
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string" || !item.call_id) {
        throw new HttpError(400, `A ${type} item is missing call_id.`, "invalid_tool_message");
      }
      started = true;
      input.push({ type, call_id: item.call_id, output: toolOutput(item.output) });
    } else if (type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content) {
      // Without encrypted_content a stateless request cannot use the item at all.
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((s) => s?.type === "summary_text" && typeof s.text === "string").map((s) => ({ type: "summary_text", text: s.text }))
        : [];
      input.push({ type: "reasoning", summary, encrypted_content: item.encrypted_content });
    } else {
      // item_reference, web_search_call, reasoning without encrypted_content, ...
      droppedItems += 1;
    }
  });
  return { input, droppedItems };
}

function nonEmptyInput(value) {
  return (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0);
}

// ---------- entry point ----------

// Accepts both Cursor wire formats on /v1/chat/completions:
//   * classic Chat Completions ({ messages: [...] })
//   * Responses-shaped bodies ({ input: [...] }) that Cursor sends for Codex models
// and produces a body for chatgpt.com/backend-api/codex/responses.
// A body with both uses `input` when it is non-empty and ignores `messages`
// (meta.ignoredMessages); otherwise `messages`. Cursor's Responses-shaped bodies
// are the newer format, so a non-empty `input` is taken as the intended one.
export function toResponsesRequest(body, { defaultReasoningEffort = "medium", defaultServiceTier } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.", "invalid_body");
  }
  if (typeof body.model !== "string" || !body.model) throw new HttpError(400, "The model field is required.", "model_required");
  if (!MODEL_ID_RE.test(body.model)) throw new HttpError(400, "The model id contains unsupported characters.", "model_not_found");

  const instructions = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) instructions.push(body.instructions);
  const { tools, kinds, customShape } = convertTools(body.tools);

  let wireFormat;
  let rawInput;
  let droppedItems = 0;
  const hasMessages = Array.isArray(body.messages) && body.messages.length > 0;
  if (nonEmptyInput(body.input)) {
    wireFormat = "input";
    ({ input: rawInput, droppedItems } = normaliseInput(body.input, instructions, kinds));
  } else if (hasMessages) {
    wireFormat = "messages";
    rawInput = messagesToInput(body.messages, instructions, kinds);
  } else if (body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input)) {
    throw new HttpError(400, "input must be a string or an array.", "invalid_input");
  } else {
    throw new HttpError(400, "Either messages or input is required.", "input_required");
  }
  const { input, orphanOutputs, missingOutputs } = pairToolItems(rawInput);
  if (input.length === 0) throw new HttpError(400, "The request contains no user, assistant or tool content.", "input_empty");

  const suffix = parseModelId(body.model);
  const requestedEffort = body.reasoning?.effort ?? body.reasoning_effort;
  const effort = suffix.effort
    ?? (EFFORTS.has(requestedEffort) ? requestedEffort : undefined)
    ?? defaultReasoningEffort;
  const summary = ["auto", "concise", "detailed", "none"].includes(body.reasoning?.summary) ? body.reasoning.summary : "auto";
  // Client-sent service_tier is ignored on purpose: priority spends quota faster,
  // so it is opt-in only through the model suffix or DEFAULT_SERVICE_TIER.
  const serviceTier = suffix.serviceTier ?? defaultServiceTier;

  const promptCacheKey = headerSafeKey(typeof body.prompt_cache_key === "string" && body.prompt_cache_key ? body.prompt_cache_key : body.user);

  const request = {
    model: suffix.model,
    instructions: instructions.join("\n\n") || DEFAULT_INSTRUCTIONS,
    input,
    ...(tools ? { tools } : {}),
    tool_choice: convertToolChoice(body.tool_choice),
    parallel_tool_calls: body.parallel_tool_calls !== false,
    reasoning: { effort, summary },
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
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
    requestedModel: body.model,
    effort,
    serviceTier,
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    customToolShape: customShape,
    ignoredMessages: wireFormat === "input" && hasMessages,
    droppedItems,
    orphanOutputs,
    missingOutputs,
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

export function errorFromEvent(event) {
  const error = event?.response?.error ?? event?.error ?? event;
  const code = typeof error?.code === "string" ? error.code : typeof error?.type === "string" ? error.type : "upstream_stream_error";
  const message = typeof error?.message === "string" ? error.message : "The upstream response failed.";
  const streamError = new UpstreamStreamError(message, code);
  // Kept for the breaker (usage_limit_reached carries a reset time).
  const resetsAt = Number(error?.resets_at);
  const resetsIn = Number(error?.resets_in_seconds);
  if (Number.isFinite(resetsAt)) streamError.resetsAt = resetsAt;
  if (Number.isFinite(resetsIn)) streamError.resetsInSeconds = resetsIn;
  return streamError;
}

const INCOMPLETE_FINISH = { max_output_tokens: "length", content_filter: "content_filter" };
const TOOL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);

// Converts Codex Responses SSE events into Chat Completions chunks. consume()
// returns the chunks to send for one event and throws UpstreamStreamError for
// terminal failures, so callers can turn them into a proper error instead of
// silently cutting the stream off.
//
// Options:
//   customToolShape "nested": the request defined custom tools Chat-style
//     ({type:"custom", custom:{...}}), so custom calls are returned as
//     {type:"custom", custom:{name, input}}. Otherwise they are returned as
//     function calls whose arguments are the raw input (the previous behaviour,
//     kept for Responses-shaped requests until real-Cursor testing says otherwise).
//   includeUsage: send the trailing usage chunk (stream_options.include_usage).
//     Usage is recorded either way, for the log.
//   onWarning(message, fields): called with counts only, never content.
export class ChatCompletionState {
  constructor(model, { customToolShape, includeUsage = true, onWarning = () => {} } = {}) {
    this.id = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.content = "";
    this.refusal = "";
    this.toolCalls = [];
    this.byKey = new Map();
    this.started = false;
    this.completed = false;
    this.usage = undefined;
    this.finishReason = "stop";
    this.nestedCustom = customToolShape === "nested";
    this.includeUsage = includeUsage;
    this.onWarning = onWarning;
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
    for (const key of [event.item_id, event.call_id, event.output_index === undefined ? undefined : `#${event.output_index}`]) {
      if (key !== undefined && this.byKey.has(key)) return this.byKey.get(key);
    }
    return undefined;
  }

  #text(call) {
    return call.type === "custom" ? call.custom.input : call.function.arguments;
  }

  #setText(call, value) {
    if (call.type === "custom") call.custom.input = value;
    else call.function.arguments = value;
  }

  #delta(index, text) {
    const call = this.toolCalls[index];
    return call.type === "custom" ? { index, custom: { input: text } } : { index, function: { arguments: text } };
  }

  #startTool(item, outputIndex, chunks) {
    const keys = [item.id, item.call_id, outputIndex === undefined ? undefined : `#${outputIndex}`].filter((k) => k !== undefined && k !== "");
    for (const key of keys) if (this.byKey.has(key)) return this.byKey.get(key);
    const index = this.toolCalls.length;
    const isCustom = item.type === "custom_tool_call";
    const initial = isCustom ? (typeof item.input === "string" ? item.input : "") : (typeof item.arguments === "string" ? item.arguments : "");
    const id = item.call_id || item.id || fallbackCallId(this.id, index);
    const name = typeof item.name === "string" ? item.name : "";
    const call = isCustom && this.nestedCustom
      ? { id, type: "custom", custom: { name, input: initial } }
      : { id, type: "function", function: { name, arguments: initial } };
    this.toolCalls.push(call);
    for (const key of keys) this.byKey.set(key, index);
    this.finishReason = "tool_calls";
    chunks.push(this.chunk({ tool_calls: [call.type === "custom"
      ? { index, id, type: "custom", custom: { name, input: initial } }
      : { index, id, type: "function", function: { name, arguments: initial } }] }));
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
    } else if (type === "response.refusal.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        this.refusal += delta;
        chunks.push(this.chunk({ refusal: delta }));
      }
    } else if (type === "response.output_item.done" && event.item?.type === "message") {
      // A refusal delivered only as a finished item (no deltas): surface it.
      if (!this.refusal && Array.isArray(event.item.content)) {
        const text = event.item.content.filter((p) => p?.type === "refusal" && typeof p.refusal === "string").map((p) => p.refusal).join("");
        if (text) {
          this.refusal = text;
          chunks.push(this.chunk({ refusal: text }));
        }
      }
    } else if (type === "response.output_item.added" && TOOL_ITEM_TYPES.has(event.item?.type)) {
      this.#startTool(event.item, event.output_index, chunks);
    } else if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
      let index = this.#toolIndex(event);
      if (index === undefined) index = this.toolCalls.length - 1;
      const delta = typeof event.delta === "string" ? event.delta : "";
      const call = this.toolCalls[index];
      if (call && delta) {
        this.#setText(call, this.#text(call) + delta);
        chunks.push(this.chunk({ tool_calls: [this.#delta(index, delta)] }));
      }
    } else if (type === "response.output_item.done" && TOOL_ITEM_TYPES.has(event.item?.type)) {
      // Some streams deliver arguments only on .done; send whatever was not streamed.
      const index = this.#startTool(event.item, event.output_index, chunks);
      const full = event.item.type === "custom_tool_call" ? event.item.input : event.item.arguments;
      const call = this.toolCalls[index];
      const streamed = this.#text(call);
      if (typeof full === "string" && full !== streamed) {
        if (full.startsWith(streamed)) {
          this.#setText(call, full);
          chunks.push(this.chunk({ tool_calls: [this.#delta(index, full.slice(streamed.length))] }));
        } else {
          // .done is authoritative. Deltas already streamed cannot be recalled,
          // but the non-streaming result and the log reflect the final value.
          this.#setText(call, full);
          this.onWarning("tool call arguments in .done do not extend the streamed text; using .done", { streamed_len: streamed.length, done_len: full.length });
        }
      }
    } else if (type === "response.completed") {
      this.completed = true;
      this.usage = usageFromResponse(event.response);
      chunks.push(this.chunk({}, this.finishReason));
      if (this.usage && this.includeUsage) chunks.push(this.usageChunk());
    } else if (type === "response.incomplete") {
      const reason = event.response?.incomplete_details?.reason;
      const finish = Object.hasOwn(INCOMPLETE_FINISH, reason) ? INCOMPLETE_FINISH[reason] : undefined;
      if (!finish) throw new UpstreamStreamError(`The upstream response was incomplete (${typeof reason === "string" ? reason : "unknown reason"}).`, "response_incomplete");
      this.completed = true;
      this.finishReason = this.finishReason === "tool_calls" ? "tool_calls" : finish;
      this.usage = usageFromResponse(event.response);
      chunks.push(this.chunk({}, this.finishReason));
      if (this.usage && this.includeUsage) chunks.push(this.usageChunk());
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
          ...(this.refusal ? { refusal: this.refusal } : {}),
          ...(this.toolCalls.length ? { tool_calls: this.toolCalls } : {})
        },
        finish_reason: this.finishReason
      }],
      ...(this.usage ? { usage: this.usage } : {})
    };
  }
}

export const translateInternals = { contentParts, messagesToInput, normaliseInput, pairToolItems, toolOutput, usageFromResponse, convertToolChoice, fallbackCallId };
