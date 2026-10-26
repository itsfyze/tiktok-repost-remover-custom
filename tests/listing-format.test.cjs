"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Engine } = require("../core.js");
const item = { id: "123", desc: "fixture travel", author: { uniqueId: "fixture" } };
const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
function harness(body) {
  const calls = [], saved = []; let serial = 0;
  const engine = new Engine({ context: () => ({ secUid: "fixture-account", csrfToken: "fake-protection-token" }), uuid: () => String(++serial), sleep: async (ms, signal) => { if (signal.aborted) throw Error("aborted"); }, persist: async (value) => saved.push(value), fetch: async (url, options) => { calls.push({ url, options }); return reply(typeof body === "function" ? body(calls.length, options) : body); } });
  return { engine, calls, saved };
}
for (const [name, body] of [
  ["canonical", { status_code: 0, itemList: [item], hasMore: false }],
  ["snake case", { status_code: 0, item_list: [item], has_more: "0" }],
  ["nested camel case", { status_code: 0, data: { itemList: [item], hasMore: false } }],
  ["nested snake case", { status_code: 0, data: { item_list: [item], has_more: 0 } }],
  ["nested list with explicit outer pagination", { status_code: 0, hasMore: false, data: { item_list: [item] } }],
]) test(`${name} listing produces validated read-only candidates`, async () => {
  const h = harness(body); h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.phase, "ready"); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.method, "GET"); assert.deepEqual(h.engine.prepare({}).batch.ids, ["123"]);
});
test("a transient missing first list is retried once at the same cursor without deletion", async () => {
  const h = harness((n) => n === 1 ? { status_code: 0 } : { status_code: 0, item_list: [item], has_more: false });
  h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.phase, "ready"); assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((call) => call.options.method === "GET" && new URL(call.url).searchParams.get("cursor") === "0"));
});
test("persistent missing list is never treated as an empty complete account", async () => {
  const h = harness({ status_code: 0, hasMore: false, secret: "must-not-appear", csrfToken: "must-not-appear" });
  h.engine.scan({}); await h.engine.running; assert.equal(h.calls.length, 2); assert.equal(h.engine.state.phase, "error"); assert.equal(h.engine.state.complete, false); assert.throws(() => h.engine.prepare({}));
  assert.match(h.engine.state.message, /root.itemList: missing/); assert.doesNotMatch(h.engine.state.message, /must-not-appear|csrfToken|secret/);
});
test("explicit empty array with terminal pagination is still a complete empty list", async () => {
  const h = harness({ status_code: 0, data: { item_list: [], has_more: false } }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.complete, true); assert.equal(h.engine.snapshot().remaining, 0);
});
test("unknown response arrays never supply removal IDs", async () => {
  const h = harness({ status_code: 0, videos: [item], arbitrary: { itemList: [item] }, hasMore: false }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.items.length, 0); assert.throws(() => h.engine.prepare({}));
});
test("ambiguous named lists are rejected instead of merged or guessed", async () => {
  const h = harness({ status_code: 0, itemList: [item], item_list: [{ ...item, id: "456" }], hasMore: false }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.calls.length, 1); assert.equal(h.engine.state.complete, false); assert.throws(() => h.engine.prepare({}));
});
test("conflicting pagination flags retain only a partial result", async () => {
  const h = harness({ status_code: 0, item_list: [item], hasMore: true, has_more: false, cursor: "30" }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.partial, true); assert.equal(h.engine.state.complete, false); assert.deepEqual(h.engine.prepare({}).batch.ids, ["123"]);
});
test("nested errors cannot be hidden inside a success envelope", async () => {
  for (const body of [
    { status_code: 0, data: { status_code: 8, item_list: [item], has_more: false } },
    { status_code: 0, statusCode: 8, itemList: [item], hasMore: false },
  ]) { const h = harness(body); h.engine.scan({}); await h.engine.running; assert.equal(h.calls.length, 1); assert.equal(h.engine.state.partial, false); assert.throws(() => h.engine.prepare({})); }
});
test("nested and outer conflicting cursors cannot complete discovery", async () => {
  const h = harness({ status_code: 0, cursor: "60", data: { item_list: [item], has_more: true, cursor: "30" } }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.calls.length, 1); assert.equal(h.engine.state.partial, true); assert.match(h.engine.state.message, /conflicting/);
});
test("nested pagination follows the exact supplied cursor", async () => {
  const h = harness((n) => n === 1 ? { status_code: 0, data: { item_list: [item], has_more: true, cursor: "30" } } : { status_code: 0, data: { item_list: [], has_more: false, cursor: "30" } });
  h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.complete, true); assert.equal(new URL(h.calls[1].url).searchParams.get("cursor"), "30");
});
test("missing verification list cannot falsely verify an accepted deletion", async () => {
  const h = harness((n, options) => options.method === "POST" ? { status_code: 0 } : n === 1 ? { status_code: 0, itemList: [item], hasMore: false } : { status_code: 0, hasMore: false });
  h.engine.scan({}); await h.engine.running; const batch = h.engine.prepare({}); h.engine.approve(batch.batch.nonce); await h.engine.running;
  assert.equal(h.engine.snapshot().removed, 0); assert.equal(h.engine.snapshot().uncertain, 1); assert.equal(h.calls.filter((call) => call.options.method === "POST").length, 1);
});
test("Stop during missing-first-page retry cancels the retry without granting authority", async () => {
  const h = harness({ status_code: 0 }); let entered; const ready = new Promise((resolve) => { entered = resolve; });
  h.engine.sleep = (ms, signal) => new Promise((resolve, reject) => { entered(); signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }); });
  h.engine.scan({}); await ready; await h.engine.stop(); assert.equal(h.calls.length, 1); assert.equal(h.engine.state.phase, "stopped"); assert.throws(() => h.engine.prepare({}));
});
