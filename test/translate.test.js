import assert from "node:assert/strict";
import test from "node:test";
import { ChatCompletionState, convertTools, parseModelId, toResponsesRequest } from "../src/translate.js";

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
  const tools = convertTools([
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
