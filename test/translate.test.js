import assert from "node:assert/strict";
import test from "node:test";
import { ChatCompletionState, convertTools, headerSafeKey, parseModelId, toResponsesRequest } from "../src/translate.js";

test("model suffix parsing", () => {
  const cases = [
    ["gpt-5.5", { model: "gpt-5.5", effort: undefined, serviceTier: undefined }],
    ["gpt-5.5-high", { model: "gpt-5.5", effort: "high", serviceTier: undefined }],
    ["gpt-5.5-low", { model: "gpt-5.5", effort: "low", serviceTier: undefined }],
    ["gpt-5.5-xhigh", { model: "gpt-5.5", effort: "xhigh", serviceTier: undefined }],
    ["gpt-5.5-xhigh-fast", { model: "gpt-5.5", effort: "xhigh", serviceTier: "priority" }],
    ["gpt-5.5-fast-high", { model: "gpt-5.5", effort: "high", serviceTier: "priority" }],
    ["gpt-5.5-priority", { model: "gpt-5.5", effort: undefined, serviceTier: "priority" }],
    ["gpt-5.6-luna", { model: "gpt-5.6-luna", effort: undefined, serviceTier: undefined }],
    ["gpt-5.5-codex-medium", { model: "gpt-5.5-codex", effort: "medium", serviceTier: undefined }],
    ["high", { model: "high", effort: undefined, serviceTier: undefined }],
    ["gpt-5.5-high-high", { model: "gpt-5.5-high", effort: "high", serviceTier: undefined }]
  ];
  for (const [id, expected] of cases) assert.deepEqual(parseModelId(id), expected, id);
});

test("defaults: medium effort, service_tier unset; client service_tier ignored", () => {
  const { request } = toResponsesRequest({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }], service_tier: "priority" });
  assert.equal(request.reasoning.effort, "medium");
  assert.equal(request.service_tier, undefined);
  const fast = toResponsesRequest({ model: "gpt-5.5-high-fast", messages: [{ role: "user", content: "hi" }] }).request;
  assert.equal(fast.model, "gpt-5.5");
  assert.equal(fast.reasoning.effort, "high");
  assert.equal(fast.service_tier, "priority");
});

test("suffix effort beats body effort, body beats default, invalid body effort ignored", () => {
  const base = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(toResponsesRequest({ ...base, model: "m-low", reasoning_effort: "high" }).request.reasoning.effort, "low");
  assert.equal(toResponsesRequest({ ...base, model: "m", reasoning: { effort: "high" } }).request.reasoning.effort, "high");
  assert.equal(toResponsesRequest({ ...base, model: "m", reasoning_effort: "turbo" }).request.reasoning.effort, "medium");
});

test("Chat Completions messages -> Responses input", () => {
  const { request, meta } = toResponsesRequest({
    model: "gpt-5.5",
    stream: true,
    stream_options: { include_usage: true },
    user: "conv-123",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Be careful." },
      { role: "developer", content: "Prefer small diffs." },
      { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
      { role: "assistant", content: "Done." }
    ],
    tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "read_file" } }
  });
  assert.equal(meta.wireFormat, "messages");
  assert.equal(request.instructions, "Be careful.");
  assert.deepEqual(request.input[0], { type: "message", role: "developer", content: [{ type: "input_text", text: "Prefer small diffs." }] });
  assert.deepEqual(request.input[1].content[1], { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" });
  assert.deepEqual(request.input[2], { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" });
  assert.deepEqual(request.input[3], { type: "function_call_output", call_id: "call_1", output: "file body" });
  assert.deepEqual(request.input[4].content, [{ type: "output_text", text: "Done." }]);
  assert.deepEqual(request.tools, [{ type: "function", name: "read_file", description: "Read", parameters: { type: "object" } }]);
  assert.deepEqual(request.tool_choice, { type: "function", name: "read_file" });
  assert.equal(request.prompt_cache_key, "conv-123");
  assert.equal(request.stream_options, undefined);
  assert.equal(request.temperature, undefined);
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.ok(meta.droppedKnown.includes("stream_options"));
});

test("Responses-shaped body (Cursor's format) on chat/completions", () => {
  const { request, meta } = toResponsesRequest({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "Use repository tools." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect." }, { type: "image_url", image_url: "https://example.invalid/x.png" }] },
      { type: "function_call", call_id: "call_9", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_9", output: { ok: true } },
      { type: "item_reference", id: "msg_1" }
    ],
    tools: [
      { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } },
      { type: "custom", name: "ApplyPatch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
      { type: "web_search" }
    ],
    reasoning: { effort: "high", summary: "auto" },
    stream: true,
    stream_options: { include_usage: true },
    store: true,
    prompt_cache_options: { mode: "implicit" },
    client_metadata: { session_id: "x" },
    user: "conv-abc",
    mystery_field: 1
  });
  assert.equal(meta.wireFormat, "input");
  assert.equal(request.instructions, "Use repository tools.");
  assert.equal(request.input.length, 3); // system hoisted, item_reference dropped
  assert.deepEqual(request.input[0].content[1], { type: "input_image", image_url: "https://example.invalid/x.png" });
  assert.equal(request.input[2].output, "{\"ok\":true}");
  assert.deepEqual(request.tools.map((t) => [t.type, t.name]), [["function", "read_file"], ["custom", "ApplyPatch"]]);
  assert.equal(request.tools[0].function, undefined);
  assert.equal(request.store, false);
  assert.equal(request.prompt_cache_key, "conv-abc");
  for (const key of ["stream_options", "prompt_cache_options", "client_metadata", "user", "mystery_field"]) assert.equal(request[key], undefined, key);
  assert.equal(meta.droppedUnknown, 1);
  assert.equal(request.reasoning.effort, "high");
});

test("rejects bodies with neither messages nor input, and tool results without ids", () => {
  assert.throws(() => toResponsesRequest({ model: "m" }), (e) => e.status === 400);
  assert.throws(() => toResponsesRequest({ model: "m", messages: [{ role: "tool", content: "x" }] }), (e) => e.status === 400);
  assert.throws(() => toResponsesRequest({ messages: [] }), (e) => e.code === "model_required");
});

test("convertTools dedupes and flattens", () => {
  const { tools } = convertTools([
    { type: "function", function: { name: "a" } },
    { type: "function", name: "a" },
    { type: "function", name: "b", parameters: { type: "object" } }
  ]);
  assert.deepEqual(tools.map((t) => t.name), ["a", "b"]);
});

function run(events, model = "gpt-5.5-high") {
  const state = new ChatCompletionState(model);
  const chunks = [];
  for (const event of events) chunks.push(...state.consume(event));
  return { state, chunks };
}

test("Responses events -> Chat Completions chunks: text, function and custom tool calls, usage", () => {
  const { state, chunks } = run([
    { type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
    { type: "response.output_text.delta", delta: "hel" },
    { type: "response.output_text.delta", delta: "lo" },
    { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "read_file", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"path\":" },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "\"a\"}" },
    { type: "response.output_item.added", output_index: 2, item: { id: "ct_1", call_id: "call_2", type: "custom_tool_call", name: "ApplyPatch", input: "" } },
    { type: "response.custom_tool_call_input.delta", item_id: "ct_1", delta: "*** Begin Patch" },
    { type: "response.output_item.done", item: { id: "ct_1", call_id: "call_2", type: "custom_tool_call", name: "ApplyPatch", input: "*** Begin Patch\n*** End Patch" } },
    { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } } } }
  ]);
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[0].model, "gpt-5.5-high");
  const done = state.completion();
  assert.equal(done.choices[0].message.content, "hello");
  assert.equal(done.choices[0].message.tool_calls[0].function.arguments, "{\"path\":\"a\"}");
  assert.equal(done.choices[0].message.tool_calls[1].function.arguments, "*** Begin Patch\n*** End Patch");
  assert.equal(done.choices[0].message.tool_calls[1].id, "call_2");
  assert.equal(done.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(done.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } });
  const last = chunks.at(-1);
  assert.deepEqual(last.choices, []);
  assert.equal(last.usage.total_tokens, 15);
  // The .done event only sent the part that had not been streamed.
  const patchDeltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []).filter((t) => t.index === 1).map((t) => t.function.arguments).join("");
  assert.equal(patchDeltas, "*** Begin Patch\n*** End Patch");
});

test("error mapping: response.failed, error, bad incomplete, truncation", () => {
  assert.throws(() => run([{ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "Too long" } } }]),
    (e) => e.status === 400 && e.code === "context_length_exceeded" && e.message === "Too long");
  assert.throws(() => run([{ type: "error", code: "usage_limit_reached", message: "Limit" }]), (e) => e.status === 429);
  assert.throws(() => run([{ type: "error", error: { type: "server_error", message: "boom" } }]), (e) => e.status === 502);
  assert.throws(() => run([{ type: "response.incomplete", response: { incomplete_details: { reason: "weird" } } }]), (e) => e.code === "response_incomplete");
  const { state } = run([{ type: "response.output_text.delta", delta: "partial" }]);
  assert.throws(() => state.finish(), (e) => e.code === "upstream_truncated");
});

test("response.incomplete for max_output_tokens finishes with length and keeps usage", () => {
  const { state, chunks } = run([
    { type: "response.output_text.delta", delta: "abc" },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 9 } } }
  ]);
  state.finish();
  assert.equal(state.completion().choices[0].finish_reason, "length");
  assert.equal(chunks.at(-1).usage.total_tokens, 10);
});

// ---------- added in the review-fix revision ----------

test("A6: Object.prototype keys are not suffixes", () => {
  for (const id of ["gpt-5.5-__proto__", "gpt-5.5-constructor", "gpt-5.5-toString", "gpt-5.5-hasOwnProperty-high"]) {
    const parsed = parseModelId(id);
    assert.equal(parsed.serviceTier, undefined, id);
    assert.equal(typeof parsed.model, "string", id);
  }
  assert.equal(parseModelId("gpt-5.5-__proto__").model, "gpt-5.5-__proto__");
  assert.equal(parseModelId("gpt-5.5-hasOwnProperty-high").effort, "high");
  const { request } = toResponsesRequest({ model: "gpt-5.5-constructor", messages: [{ role: "user", content: "x" }] });
  assert.equal(request.service_tier, undefined);
  assert.equal(request.model, "gpt-5.5-constructor");
});

test("A3/A7: model ids cannot carry header syntax; bad cache keys are hashed, stably", () => {
  for (const model of ["gpt-5.5;tier=priority", "gpt-5.5\r\nx: y", "gpt 5.5", "gpt-5.5é", "a".repeat(65)]) {
    assert.throws(() => toResponsesRequest({ model, messages: [{ role: "user", content: "x" }] }), (e) => e.status === 400, model);
  }
  const base = { model: "gpt-5.5", messages: [{ role: "user", content: "x" }] };
  for (const user of ["conv\r\nx-evil: 1", "conv ", "日本語", "x".repeat(300), " leading"]) {
    const key = toResponsesRequest({ ...base, user }).request.prompt_cache_key;
    assert.match(key, /^pck_[0-9a-f]{24}$/, JSON.stringify(user));
    assert.equal(toResponsesRequest({ ...base, user }).request.prompt_cache_key, key, "stable");
    assert.doesNotThrow(() => new Headers({ session_id: key }));
  }
  assert.equal(toResponsesRequest({ ...base, user: "conv-ok 1" }).request.prompt_cache_key, "conv-ok 1");
  assert.equal(headerSafeKey(undefined), undefined);
});

test("A1: nested Chat custom tools are kept, with grammar format converted", () => {
  const { tools, kinds, customShape } = convertTools([
    { type: "custom", custom: { name: "ApplyPatch", description: "Patch", format: { type: "grammar", grammar: { syntax: "lark", definition: "start: /.+/" } } } },
    { type: "custom", name: "Flat", format: { type: "grammar", syntax: "regex", definition: ".*" } },
    { type: "custom", custom: { name: "Weird", format: { type: "grammar", grammar: { syntax: "ebnf", definition: "x" } } } },
    { type: "function", function: { name: "read_file" } }
  ]);
  assert.equal(customShape, "nested");
  assert.deepEqual(tools[0], { type: "custom", name: "ApplyPatch", description: "Patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } });
  assert.deepEqual(tools[1], { type: "custom", name: "Flat", format: { type: "grammar", syntax: "regex", definition: ".*" } });
  assert.deepEqual(tools[2], { type: "custom", name: "Weird" }, "unknown grammar syntax drops the format, not the tool");
  assert.equal(kinds.get("ApplyPatch"), "custom");
  assert.equal(kinds.get("read_file"), "function");
  assert.equal(convertTools([{ type: "custom", name: "X" }]).customShape, "flat");
});

test("A1: assistant custom tool_calls become custom_tool_call; their results custom_tool_call_output", () => {
  const { request, meta } = toResponsesRequest({
    model: "gpt-5.5",
    tools: [{ type: "custom", custom: { name: "ApplyPatch" } }, { type: "function", function: { name: "read_file" } }],
    messages: [
      { role: "user", content: "patch it" },
      { role: "assistant", content: null, tool_calls: [
        { id: "call_c", type: "custom", custom: { name: "ApplyPatch", input: "*** Begin Patch\n*** End Patch" } },
        { id: "call_f", type: "function", function: { name: "read_file", arguments: "{}" } }
      ] },
      { role: "tool", tool_call_id: "call_c", content: "Done" },
      { role: "tool", tool_call_id: "call_f", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
    ]
  });
  assert.deepEqual(request.input.slice(1), [
    { type: "custom_tool_call", call_id: "call_c", name: "ApplyPatch", input: "*** Begin Patch\n*** End Patch" },
    { type: "function_call", call_id: "call_f", name: "read_file", arguments: "{}" },
    { type: "custom_tool_call_output", call_id: "call_c", output: "Done" },
    { type: "function_call_output", call_id: "call_f", output: "a\nb" }
  ]);
  assert.equal(meta.orphanOutputs, 0);
  assert.equal(meta.customToolShape, "nested");
});

test("A1: orphan outputs are dropped, unanswered calls get the aborted placeholder", () => {
  const { request, meta } = toResponsesRequest({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "x" },
      { role: "tool", tool_call_id: "call_ghost", content: "nobody asked" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "user", content: "never mind" }
    ]
  });
  const types = request.input.map((i) => i.type);
  assert.deepEqual(types, ["message", "function_call", "function_call_output", "message"]);
  assert.equal(request.input[2].output, "aborted");
  assert.equal(meta.orphanOutputs, 1);
  assert.equal(meta.missingOutputs, 1);
  for (const item of request.input) {
    if (item.type.endsWith("_output")) assert.ok(request.input.some((c) => c.call_id === item.call_id && !c.type.endsWith("_output")));
  }
});

test("A2: Responses-shaped items are rebuilt from an allowlist; ids and status dropped", () => {
  const { request, meta } = toResponsesRequest({
    model: "gpt-5.5",
    tools: [{ type: "custom", name: "ApplyPatch" }],
    input: [
      { id: "msg_1", type: "message", role: "user", status: "completed", content: [{ type: "input_text", text: "hi", annotations: [] }, { type: "input_file", file_id: "f1", junk: 1 }] },
      { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "s" }], content: [{ type: "reasoning_text", text: "raw" }], encrypted_content: "ENC" },
      { id: "rs_2", type: "reasoning", summary: [] },
      { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "read_file", arguments: { path: "a" }, extra: true },
      { id: "fco_1", type: "function_call_output", call_id: "call_1", output: "ok", status: "completed" },
      { id: "ctc_1", type: "custom_tool_call", call_id: "call_2", name: "ApplyPatch", input: "P", status: "completed" },
      { type: "function_call_output", call_id: "call_2", output: "applied" },
      { type: "message", role: "assistant", id: "msg_2", content: [{ type: "output_text", text: "done", annotations: [], logprobs: [] }] }
    ]
  });
  const text = JSON.stringify(request.input);
  for (const banned of ["\"id\"", "status", "extra", "junk", "annotations", "logprobs", "reasoning_text"]) assert.ok(!text.includes(banned), banned);
  assert.deepEqual(request.input[0].content, [{ type: "input_text", text: "hi" }, { type: "input_file", file_id: "f1" }]);
  assert.deepEqual(request.input[1], { type: "reasoning", summary: [{ type: "summary_text", text: "s" }], encrypted_content: "ENC" });
  assert.deepEqual(request.input[2], { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" });
  assert.deepEqual(request.input[3], { type: "function_call_output", call_id: "call_1", output: "ok" });
  assert.deepEqual(request.input[5], { type: "custom_tool_call_output", call_id: "call_2", output: "applied" }, "output retyped to match its custom call");
  assert.equal(meta.droppedItems, 1, "reasoning without encrypted_content dropped");
});

test("A11: input wins over messages when non-empty; empty input falls back to messages", () => {
  const both = toResponsesRequest({ model: "m", input: "from input", messages: [{ role: "user", content: "from messages" }] });
  assert.equal(both.meta.wireFormat, "input");
  assert.equal(both.meta.ignoredMessages, true);
  assert.equal(both.request.input[0].content[0].text, "from input");
  const emptyInput = toResponsesRequest({ model: "m", input: [], messages: [{ role: "user", content: "from messages" }] });
  assert.equal(emptyInput.meta.wireFormat, "messages");
  assert.equal(emptyInput.request.input[0].content[0].text, "from messages");
  assert.throws(() => toResponsesRequest({ model: "m", input: [], messages: [] }), (e) => e.code === "input_required");
  assert.throws(() => toResponsesRequest({ model: "m", input: 5 }), (e) => e.code === "invalid_input");
});

test("A11: leading system -> instructions; later system stays in place as developer", () => {
  for (const shape of ["messages", "input"]) {
    const items = [
      { role: "system", content: "Lead." },
      { role: "user", content: "q1" },
      { role: "system", content: "Mid-conversation rule." },
      { role: "user", content: "q2" }
    ];
    const body = shape === "messages" ? { model: "m", messages: items } : { model: "m", input: items.map((i) => ({ type: "message", ...i })) };
    const { request } = toResponsesRequest(body);
    assert.equal(request.instructions, "Lead.", shape);
    assert.deepEqual(request.input.map((i) => i.role), ["user", "developer", "user"], shape);
    assert.equal(request.input[1].content[0].text, "Mid-conversation rule.", shape);
  }
});

test("A11: images in tool results are kept", () => {
  const { request } = toResponsesRequest({
    model: "m",
    messages: [
      { role: "user", content: "screenshot" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "here" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }
    ]
  });
  assert.deepEqual(request.input[2].output, [{ type: "input_text", text: "here" }, { type: "input_image", image_url: "data:image/png;base64,AA" }]);
});

test("B6: missing call ids get a deterministic fallback; identical requests are byte-identical", () => {
  const body = {
    model: "m",
    user: "conv-1",
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "f", arguments: "{\"a\":1}" } }] }
    ]
  };
  const a = toResponsesRequest(structuredClone(body)).request;
  const b = toResponsesRequest(structuredClone(body)).request;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.match(a.input[1].call_id, /^call_[0-9a-f]{24}$/);
  const other = structuredClone(body);
  other.messages[1].tool_calls[0].function.arguments = "{\"a\":2}";
  assert.notEqual(toResponsesRequest(other).request.input[1].call_id, a.input[1].call_id);
});

test("custom tool calls on the output side: nested shape uses {type:custom, custom:{name,input}}", () => {
  const events = [
    { type: "response.created", response: { id: "resp_9" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "ct_1", call_id: "call_p", type: "custom_tool_call", name: "ApplyPatch", input: "" } },
    { type: "response.custom_tool_call_input.delta", item_id: "ct_1", delta: "*** Begin" },
    { type: "response.output_item.done", output_index: 0, item: { id: "ct_1", call_id: "call_p", type: "custom_tool_call", name: "ApplyPatch", input: "*** Begin\n*** End" } },
    { type: "response.completed", response: { id: "resp_9" } }
  ];
  const nested = new ChatCompletionState("m", { customToolShape: "nested" });
  const chunks = events.flatMap((e) => nested.consume(e));
  const deltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.deepEqual(deltas[0], { index: 0, id: "call_p", type: "custom", custom: { name: "ApplyPatch", input: "" } });
  assert.deepEqual(deltas.slice(1).map((d) => d.custom.input).join(""), "*** Begin\n*** End");
  assert.deepEqual(nested.completion().choices[0].message.tool_calls[0], { id: "call_p", type: "custom", custom: { name: "ApplyPatch", input: "*** Begin\n*** End" } });
  const flat = new ChatCompletionState("m", { customToolShape: "flat" });
  for (const e of events) flat.consume(e);
  assert.equal(flat.completion().choices[0].message.tool_calls[0].type, "function");
});

test("interleaved parallel tool-call deltas land on the right index", () => {
  const { state, chunks } = run([
    { type: "response.output_item.added", output_index: 0, item: { id: "fc_a", call_id: "call_a", type: "function_call", name: "a", arguments: "" } },
    { type: "response.output_item.added", output_index: 1, item: { id: "fc_b", call_id: "call_b", type: "function_call", name: "b", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_b", delta: "{\"b\":" },
    { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "{\"a\":" },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "2}" },
    { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "1}" },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc_b", call_id: "call_b", type: "function_call", name: "b", arguments: "{\"b\":2}" } },
    { type: "response.output_item.done", output_index: 0, item: { id: "fc_a", call_id: "call_a", type: "function_call", name: "a", arguments: "{\"a\":1}" } },
    { type: "response.completed", response: {} }
  ]);
  const calls = state.completion().choices[0].message.tool_calls;
  assert.deepEqual(calls.map((c) => [c.id, c.function.arguments]), [["call_a", "{\"a\":1}"], ["call_b", "{\"b\":2}"]]);
  const byIndex = [0, 1].map((i) => chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []).filter((t) => t.index === i).map((t) => t.function.arguments).join(""));
  assert.deepEqual(byIndex, ["{\"a\":1}", "{\"b\":2}"]);
});

test("A10: .done arguments that do not extend the streamed text are authoritative and logged by length", () => {
  const warnings = [];
  const state = new ChatCompletionState("m", { onWarning: (message, fields) => warnings.push({ message, fields }) });
  for (const e of [
    { type: "response.output_item.added", item: { id: "fc", call_id: "c", type: "function_call", name: "f", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc", delta: "{\"x\":SECRET" },
    { type: "response.output_item.done", item: { id: "fc", call_id: "c", type: "function_call", name: "f", arguments: "{\"y\":2}" } },
    { type: "response.completed", response: {} }
  ]) state.consume(e);
  assert.equal(state.completion().choices[0].message.tool_calls[0].function.arguments, "{\"y\":2}");
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].fields, { streamed_len: 11, done_len: 7 });
  assert.ok(!JSON.stringify(warnings).includes("SECRET"));
});

test("A11: usage chunk only with include_usage; refusals surfaced", () => {
  const events = [
    { type: "response.refusal.delta", delta: "I can't " },
    { type: "response.refusal.delta", delta: "help." },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }
  ];
  const off = new ChatCompletionState("m", { includeUsage: false });
  const offChunks = events.flatMap((e) => off.consume(e));
  assert.ok(!offChunks.some((c) => c.usage), "no usage chunk");
  assert.equal(off.usage.total_tokens, 2, "usage still recorded");
  assert.equal(off.completion().choices[0].message.refusal, "I can't help.");
  assert.ok(offChunks.some((c) => c.choices[0]?.delta?.refusal === "help."));
  const on = new ChatCompletionState("m", { includeUsage: true });
  assert.ok(events.flatMap((e) => on.consume(e)).some((c) => c.usage));
  const doneOnly = new ChatCompletionState("m");
  doneOnly.consume({ type: "response.output_item.done", item: { type: "message", content: [{ type: "refusal", refusal: "No." }] } });
  assert.equal(doneOnly.refusal, "No.");
});
