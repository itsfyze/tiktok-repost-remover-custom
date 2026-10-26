"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { Engine } = require("../core.js");
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => typeof data === "string" ? data : JSON.stringify(data) });
const page = (ids) => response({ status_code: 0, itemList: ids.map((id) => ({ id, desc: "fixture" })), hasMore: false });
function fixture() {
  const calls = [], saved = []; let clock = 0, serial = 0; const remaining = ["1", "2"];
  const engine = new Engine({ now: () => clock, context: () => ({ secUid: "fixture", csrfToken: "fixture-only" }), uuid: () => String(++serial), sleep: async (ms, signal) => { if (signal.aborted) throw Error("abort"); clock += ms; }, persist: async (value) => saved.push(value), fetch: async (url, options) => { calls.push({ at: clock, url, method: options.method }); if (options.method === "POST") { const id = new URL(url).searchParams.get("item_id"); remaining.splice(remaining.indexOf(id), 1); return response({ status_code: 0 }); } return page(remaining); } });
  return { engine, calls, saved, remaining };
}
async function scan(h) { h.engine.scan({ limit: 1, delay: 3 }); await h.engine.running; }
async function approve(h, config = { limit: 1, delay: 3 }) { const review = h.engine.prepare(config); h.engine.approve(review.batch.nonce); await h.engine.running; }
test("accepted requests become uncertain after restore without restoring authority", () => {
  const h = fixture(); h.engine.restore({ schema: 1, state: { account: "fixture", settings: {}, items: [], outcomes: { "1": { status: "accepted" }, "2": { status: "in_flight" } } } });
  assert.equal(h.engine.snapshot().uncertain, 2); assert.equal(h.engine.approval, null); assert.throws(() => h.engine.prepare({})); assert.equal(h.calls.length, 0);
});
test("malformed checkpoint records and options do not permanently break startup", () => {
  const h = fixture(); h.engine.restore({ schema: 1, state: { account: "fixture", settings: { delay: -1 }, items: [], outcomes: { "1": null, "2": { status: "unexpected" }, "3": { status: "failed", at: NaN }, bad: { status: "accepted" } }, cooldownUntil: Infinity } });
  assert.equal(h.engine.state.settings.delay, 5); assert.deepEqual(h.engine.state.outcomes, { "3": { status: "failed", at: 0 } }); assert.equal(h.engine.state.cooldownUntil, 0);
});
test("checkpoint history without a valid account identifier is discarded", () => {
  const h = fixture(); h.engine.restore({ schema: 1, state: { account: "bad account", items: [], outcomes: { "1": { status: "verified_removed" } } } }); assert.equal(h.engine.snapshot().removed, 0);
});
test("delay applies from scan GET to first POST and across separate batches", async () => {
  const h = fixture(); await scan(h); await approve(h); await approve(h);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 3000);
});
test("increasing the delay before approval applies immediately to the next request", async () => {
  const h = fixture(); await scan(h); await approve(h, { delay: 20, limit: 1 }); assert.ok(h.calls[1].at - h.calls[0].at >= 20000);
});
test("each progressive approval obeys minimum spacing even when approved immediately", async () => {
  const h = fixture(); h.engine.scanAndRemove({ delay: 3, limit: 1 });
  while (h.engine.running) { if (h.engine.state.phase === "awaiting") h.engine.approve(h.engine.state.batch.nonce); await new Promise((r) => setImmediate(r)); }
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 2); for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 3000);
});
test("cooldown blocks preparation, approval and direct requests centrally", async () => {
  const h = fixture(); await scan(h); const review = h.engine.prepare({}); h.engine.state.cooldownUntil = Date.now() + 60000;
  assert.throws(() => h.engine.prepare({}), { code: "COOLDOWN" }); assert.throws(() => h.engine.approve(review.batch.nonce), { code: "COOLDOWN" }); await assert.rejects(h.engine.request("/api/repost/item_list/", {}), { code: "COOLDOWN" }); assert.equal(h.calls.length, 1);
});
test("approval is expired at its exact deadline, not only after it", async () => {
  const h = fixture(); await scan(h); const review = h.engine.prepare({}); const original = Date.now;
  try { Date.now = () => h.engine.approval.expires; assert.throws(() => h.engine.approve(review.batch.nonce), { code: "UNAUTHORIZED" }); }
  finally { Date.now = original; }
});
test("Stop aborts a pending minimum-spacing delay before dispatch", async () => {
  const h = fixture(); await scan(h); let enter; const ready = new Promise((r) => { enter = r; });
  h.engine.sleep = (ms, signal) => new Promise((resolve, reject) => { enter(); signal.addEventListener("abort", () => reject(Error("abort")), { once: true }); });
  const review = h.engine.prepare({ delay: 120 }); h.engine.approve(review.batch.nonce); await ready; await h.engine.stop(); assert.equal(h.calls.length, 1);
});
test("empty successful POST follows reference behavior but still requires full verification", async () => {
  const h = fixture(); await scan(h); const original = h.engine.fetch;
  h.engine.fetch = async (url, options) => { if (options.method === "POST") { h.remaining.shift(); return response("", 204); } return original(url, options); };
  await approve(h); assert.equal(h.engine.snapshot().removed, 1);
});
test("empty POST acknowledgement followed by empty GET stays uncertain", async () => {
  const h = fixture(); await scan(h); let posts = 0;
  h.engine.fetch = async (url, options) => { if (options.method === "POST") posts++; return response(""); };
  await approve(h); assert.equal(posts, 1); assert.equal(h.engine.snapshot().removed, 0); assert.equal(h.engine.snapshot().uncertain, 1);
});
test("nested POST rejection cannot masquerade as an accepted removal", async () => {
  const h = fixture(); await scan(h); h.engine.fetch = async () => response({ status_code: 0, data: { status_code: 9 } }); await approve(h); assert.equal(h.engine.snapshot().failed, 1); assert.equal(h.engine.snapshot().removed, 0);
});
test("arbitrary rejected status text is never reflected into dashboard or saved history", async () => {
  const h = fixture(); h.engine.fetch = async () => response({ status_code: "sensitive-fixture-value" }); await scan(h); assert.doesNotMatch(JSON.stringify(h.saved), /sensitive-fixture-value/);
});
test("extreme Retry-After remains finite and survives checkpoint restore", async () => {
  const h = fixture(); h.engine.fetch = async () => ({ ...response({}, 429), headers: { get: () => "999999999999999999999999999999" } }); await scan(h); assert.ok(Number.isFinite(h.engine.state.cooldownUntil)); const fresh = fixture(); fresh.engine.restore({ schema: 1, state: h.saved.at(-1) }); assert.ok(fresh.engine.state.cooldownUntil > Date.now());
});
test("a new verification reconciles older uncertain operations as well as its own batch", async () => {
  const h = fixture(); await scan(h); h.engine.state.outcomes["9"] = { status: "uncertain" }; await approve(h); assert.equal(h.engine.state.outcomes["9"].status, "verified_removed");
});
function ui() {
  const nodes = new Map(), pending = [], timers = new Map(); let serial = 0;
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { value: "5", checked: false, disabled: false, hidden: true, textContent: "", classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, replaceChildren() {}, append() {} }); return nodes.get(id); };
  const sandbox = { document: { getElementById: node, createElement: () => node("created" + (++serial)) }, chrome: { runtime: { sendMessage: (command) => new Promise((resolve, reject) => pending.push({ command, resolve, reject })) } }, setInterval() {}, setTimeout: (fn) => { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id), console };
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8"), sandbox);
  const state = (phase) => ({ ok: true, connected: true, state: { version: "1.0.5", phase, settings: { delay: 5, limit: 5, keywords: "" }, items: [], message: phase, cooldownUntil: 0 } });
  return { pending, timers, node, state, run: (code) => vm.runInContext(code, sandbox) };
}
test("a stale poll cannot overwrite a newer user action", async () => {
  const h = ui(); const action = h.run('send("connect")'); h.pending[1].resolve(h.state("ready")); await action; h.pending[0].resolve(h.state("scanning")); await new Promise((r) => setImmediate(r)); assert.equal(h.node("phase").textContent, "ready");
});
test("a stale polling failure cannot disconnect a newly reconnected dashboard", async () => {
  const h = ui(); const action = h.run('send("connect")'); h.pending[1].resolve(h.state("ready")); await action; h.pending[0].reject(Error("old failure")); await new Promise((r) => setImmediate(r)); assert.equal(h.node("phase").textContent, "ready");
});
test("an unanswered UI action times out and never silently retries", async () => {
  const h = ui(); h.pending[0].resolve(h.state("removing")); await new Promise((r) => setImmediate(r)); const action = h.run('send("stop")'); [...h.timers.values()][0](); await action;
  assert.equal(h.node("phase").textContent, "connection lost"); assert.equal(h.node("stop").disabled, false); assert.equal(h.pending.filter((p) => p.command.type === "stop").length, 1); assert.equal(h.run("busy"), false);
});
