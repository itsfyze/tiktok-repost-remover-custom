"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Engine, settings } = require("../core.js");
const context = () => ({ secUid: "test-account", csrfToken: "synthetic-csrf" });
const item = (id, desc = "travel") => ({ id, desc, author: { uniqueId: "fixture" } });
const json = (data, status = 200, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (name) => headers[name] || null }, text: async () => JSON.stringify(data) });
const listing = (items = [item("1"), item("2")], hasMore = false, cursor = "0") => json({ status_code: 0, itemList: items, hasMore, cursor });
function harness(custom = {}) {
  const calls = [], saved = [];
  const remaining = new Map([["1", item("1")], ["2", item("2")]]);
  let serial = 0;
  const engine = new Engine({ context, uuid: () => `nonce-${++serial}`, sleep: async (ms, signal) => { if (signal.aborted) throw Error("aborted"); }, persist: async (state) => { saved.push(state); },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST") { remaining.delete(new URL(url).searchParams.get("item_id")); return json({ status_code: 0 }); }
      return listing([...remaining.values()]);
    }, ...custom });
  return { engine, calls, saved, remaining };
}
async function scanned(h = harness()) { h.engine.scan({ delay: 3, limit: 1 }); await h.engine.running; assert.equal(h.engine.state.phase, "ready"); return h; }
async function approved(h) { const s = h.engine.prepare({ delay: 3, limit: 1 }); h.engine.approve(s.batch.nonce); await h.engine.running; }
test("settings enforce safe bounds and defaults", () => {
  assert.equal(settings().limit, 5);
  for (const bad of [{ delay: 0 }, { delay: NaN }, { delay: 121 }, { limit: -1 }, { limit: 1.5 }, { limit: 1001 }]) assert.throws(() => settings(bad));
});
test("dry scan sends GET only and discovers all items", async () => {
  const h = await scanned(); assert.equal(h.engine.snapshot().remaining, 2); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.method, "GET");
  assert.equal(h.calls[0].options.credentials, "same-origin"); assert.equal(h.calls[0].options.redirect, "error"); assert.equal(h.calls[0].options.mode, "same-origin");
});
test("no request without an authorized job", async () => {
  const h = harness(); await assert.rejects(h.engine.request("/tiktok/v1/upvote/delete", { item_id: "1" }, "POST"), { code: "UNAUTHORIZED" }); assert.equal(h.calls.length, 0);
});
test("unknown endpoint and wrong method fail closed", async () => {
  const h = harness(); await assert.rejects(h.engine.request("https://evil.test", {})); await assert.rejects(h.engine.request("/tiktok/v1/upvote/delete", {})); await assert.rejects(h.engine.request("/api/repost/item_list/", {}, "DELETE")); assert.equal(h.calls.length, 0);
});
test("prepare does not delete; approval bound to nonce and IDs", async () => {
  const h = await scanned(); const state = h.engine.prepare({ delay: 3, limit: 1 });
  assert.deepEqual(state.batch.ids, ["1"]); assert.equal(h.calls.length, 1);
  assert.throws(() => h.engine.approve("wrong"), { code: "UNAUTHORIZED" });
  await assert.rejects(h.engine.request("/tiktok/v1/upvote/delete", { item_id: "2" }, "POST"), { code: "UNAUTHORIZED" });
  h.engine.approve(state.batch.nonce); assert.throws(() => h.engine.approve(state.batch.nonce)); await h.engine.running;
  assert.deepEqual(h.calls.filter((c) => c.options.method === "POST").map((c) => new URL(c.url).searchParams.get("item_id")), ["1"]);
  assert.equal(h.engine.snapshot().removed, 1); assert.equal(h.engine.snapshot().remaining, 1);
  await assert.rejects(h.engine.request("/tiktok/v1/upvote/delete", { item_id: "1" }, "POST"), { code: "UNAUTHORIZED" });
});
test("each subsequent batch needs fresh approval", async () => {
  const h = await scanned(); await approved(h); const n = h.calls.length;
  const next = h.engine.prepare({ delay: 3, limit: 1 }); assert.deepEqual(next.batch.ids, ["2"]); assert.equal(h.calls.length, n); assert.equal(h.engine.state.phase, "awaiting");
});
test("expired approval rejected", async () => {
  const h = await scanned(); const s = h.engine.prepare({ delay: 3, limit: 1 }); h.engine.approval.expires = 0; assert.throws(() => h.engine.approve(s.batch.nonce), { code: "UNAUTHORIZED" });
});
test("keyword filter limits exact IDs and no matches fails closed", async () => {
  const h = await scanned(); h.engine.state.items[1].desc = "cats";
  assert.deepEqual(h.engine.prepare({ delay: 3, limit: 100, keywords: "CAT" }).batch.ids, ["2"]);
  assert.throws(() => h.engine.prepare({ keywords: "nonexistent" }), { code: "EMPTY" });
});
test("account change invalidates an approval before any write", async () => {
  let who = context(); const h = await scanned(harness({ context: () => who })); const s = h.engine.prepare({ delay: 3, limit: 1 }); who = { ...who, secUid: "other-account" };
  assert.throws(() => h.engine.approve(s.batch.nonce), { code: "ACCOUNT_CHANGED" }); assert.equal(h.calls.filter((c) => c.options.method === "POST").length, 0);
});
test("missing account and missing CSRF do not bypass authentication", async () => {
  assert.throws(() => harness({ context: () => null }).engine.scan({}), { code: "LOGIN" });
  const h = await scanned(harness({ context: () => ({ secUid: "test-account", csrfToken: "" }) })); await approved(h); assert.equal(h.engine.state.phase, "error"); assert.equal(h.calls.filter((c) => c.options.method === "POST").length, 0);
});
test("stop aborts active scan and leaves no request/controller", async () => {
  let started; const ready = new Promise((r) => { started = r; });
  const h = harness({ fetch: async (url, options) => new Promise((resolve, reject) => { started(); options.signal.addEventListener("abort", () => reject(new Error("aborted"))); }) });
  h.engine.scan({}); await ready; assert.equal(h.engine.active.size, 1); await h.engine.stop(); assert.equal(h.engine.active.size, 0); assert.equal(h.engine.state.phase, "stopped"); assert.equal(h.engine.running, null); assert.throws(() => h.engine.resume());
});
test("stop during POST aborts, marks uncertain, and never dispatches next ID", async () => {
  const h = await scanned(); let start; const ready = new Promise((r) => { start = r; }); let posts = 0;
  h.engine.fetch = async (url, options) => { assert.equal(options.method, "POST"); posts++; return new Promise((resolve, reject) => { start(); options.signal.addEventListener("abort", () => reject(new Error("abort"))); }); };
  const s = h.engine.prepare({ delay: 3, limit: 2 }); h.engine.approve(s.batch.nonce); await ready; await h.engine.stop();
  assert.equal(posts, 1); assert.equal(h.engine.snapshot().uncertain, 1); assert.equal(h.engine.active.size, 0); assert.equal(h.engine.approval, null);
});
test("timeout aborts before settling; POST has no overlapping automatic retry", async () => {
  const h = await scanned(); let posts = 0, aborted = false;
  h.engine.timeout = 10;
  h.engine.fetch = async (url, options) => { posts++; return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); })); };
  await approved(h); assert.equal(posts, 1); assert.equal(aborted, true); assert.equal(h.engine.active.size, 0); assert.equal(h.engine.snapshot().uncertain, 1); assert.equal(h.engine.state.phase, "error");
});
test("unique request IDs even across batches", async () => {
  const h = await scanned(); const before = h.engine.uuid(); await approved(h); const after = h.engine.uuid(); assert.notEqual(before, after);
});
test("rate limit honors Retry-After, halts and requires fresh consent", async () => {
  const h = await scanned(); let posts = 0;
  h.engine.fetch = async () => { posts++; return json({}, 429, { "retry-after": "120" }); };
  const now = Date.now(); await approved(h); assert.equal(posts, 1); assert.equal(h.engine.state.phase, "rate_limited"); assert.ok(h.engine.state.cooldownUntil >= now + 120000); assert.throws(() => h.engine.scan({}), { code: "COOLDOWN" }); assert.equal(h.engine.approval, null);
});
test("rate-limit HTTP date and absent header are conservative", async () => {
  for (const header of [new Date(Date.now() + 180000).toUTCString(), null]) {
    const h = harness({ fetch: async () => json({}, 429, header ? { "retry-after": header } : {}) }); h.engine.scan({}); await h.engine.running;
    assert.equal(h.engine.state.phase, "rate_limited"); assert.ok(h.engine.state.cooldownUntil > Date.now() + 59000);
  }
});
test("401, 403, 500 and TikTok rejection all halt without retries", async () => {
  for (const status of [401, 403, 500, 200]) {
    const h = await scanned(); let calls = 0; h.engine.fetch = async () => { calls++; return json({ status_code: 123 }, status); }; await approved(h);
    assert.equal(calls, 1); assert.equal(h.engine.state.phase, "error"); assert.equal(h.engine.approval, null);
  }
});
test("empty, non-JSON and oversized responses never count as success", async () => {
  for (const raw of ["", "<html>challenge</html>", "x".repeat(8000001)]) {
    const h = await scanned(); h.engine.fetch = async () => ({ ok: true, status: 200, text: async () => raw }); await approved(h); assert.equal(h.engine.state.phase, "error"); assert.equal(h.engine.snapshot().removed, 0);
  }
});
test("strict listing schema, numeric IDs, cursor loops and incomplete pagination", async () => {
  for (const data of [ { status_code: 0 }, { status_code: 0, itemList: [], hasMore: "unknown" }, { status_code: 0, itemList: [item("bad-id")], hasMore: false }, { status_code: 0, itemList: [], hasMore: true, cursor: null }, { status_code: 0, itemList: [], hasMore: true, cursor: "0" } ]) {
    const h = harness({ fetch: async () => json(data) }); h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.complete, false); assert.equal(h.engine.state.phase, "error"); assert.throws(() => h.engine.prepare({}));
  }
});
test("2487 valid reposts survive a later malformed listing and require fresh batch approval", async () => {
  const videos = Array.from({ length: 2487 }, (_, index) => item(String(index + 1)));
  const pages = [listing(videos, true, "30"), json({ status_code: 0 })];
  let posts = 0;
  const h = harness({ fetch: async (url, options) => { if (options.method === "POST") posts++; return pages.shift(); } });
  h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.phase, "partial"); assert.equal(h.engine.state.items.length, 2487);
  assert.equal(h.engine.state.complete, false); assert.equal(h.engine.snapshot().remaining, null);
  const s = h.engine.prepare({ limit: 5, delay: 3 }); assert.deepEqual(s.batch.ids, ["1", "2", "3", "4", "5"]); assert.equal(s.batch.partial, true); assert.equal(posts, 0);
  assert.throws(() => h.engine.approve("forged"), { code: "UNAUTHORIZED" }); assert.equal(posts, 0);
});
test("explicit string and numeric pagination flags have boolean semantics", async () => {
  for (const value of [false, 0, "0", "false"]) {
    let calls = 0; const h = harness({ fetch: async () => { calls++; return listing([item("1")], value); } });
    h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.complete, true); assert.equal(calls, 1);
  }
  for (const value of [true, 1, "1", "true"]) {
    const pages = [listing([item("1")], value, "30"), listing([item("2")])]; const h = harness({ fetch: async () => pages.shift() });
    h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.complete, true); assert.equal(h.engine.state.items.length, 2);
  }
});
test("valid items with a missing flag remain partial, never a fabricated complete total", async () => {
  const h = harness({ fetch: async () => json({ status_code: 0, itemList: [item("1")] }) }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.partial, true); assert.equal(h.engine.state.complete, false); assert.equal(h.engine.snapshot().actionable, 1);
});
test("invalid individual IDs are excluded while known valid IDs can be approved", async () => {
  const h = harness({ fetch: async () => listing([item("1"), item("bad-id"), null, item("2")]) }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.partial, true); assert.deepEqual(h.engine.prepare({ limit: 5 }).batch.ids, ["1", "2"]);
  await assert.rejects(h.engine.request("/tiktok/v1/upvote/delete", { item_id: "bad-id" }, "POST"), { code: "UNAUTHORIZED" });
});
test("pagination loop preserves validated results without retrying a cursor", async () => {
  let calls = 0; const h = harness({ fetch: async () => { calls++; return listing([item("1")], true, "0"); } });
  h.engine.scan({}); await h.engine.running; assert.equal(calls, 1); assert.equal(h.engine.state.phase, "partial"); assert.deepEqual(h.engine.prepare({}).batch.ids, ["1"]);
});
test("late session, rate-limit, server and TikTok errors cannot authorize partial removal", async () => {
  for (const response of [json({}, 401), json({}, 403), json({}, 429), json({}, 500), json({ status_code: 123 })]) {
    const pages = [listing([item("1")], true, "30"), response]; const h = harness({ fetch: async () => pages.shift() });
    h.engine.scan({}); await h.engine.running;
    assert.equal(h.engine.state.partial, false); assert.equal(h.engine.state.complete, false); assert.throws(() => h.engine.prepare({}));
    assert.equal(h.engine.approval, null);
  }
});
test("late raw challenge/empty/non-JSON responses cannot authorize partial removal", async () => {
  for (const raw of ["<html>challenge</html>", "", "not json"]) {
    const pages = [listing([item("1")], true, "30"), { ok: true, status: 200, text: async () => raw }]; const h = harness({ fetch: async () => pages.shift() });
    h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.partial, false); assert.throws(() => h.engine.prepare({}));
  }
});
test("a partial candidate batch can be deleted and fully verified after explicit approval", async () => {
  const h = harness(); let first = true;
  h.engine.fetch = async (url, options) => {
    if (options.method === "POST") { h.remaining.delete(new URL(url).searchParams.get("item_id")); return json({ status_code: 0 }); }
    if (first) { first = false; return json({ status_code: 0, itemList: [...h.remaining.values()] }); }
    return listing([...h.remaining.values()]);
  };
  h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.partial, true);
  await approved(h); assert.equal(h.engine.snapshot().removed, 1); assert.equal(h.engine.state.complete, true); assert.equal(h.engine.state.partial, false);
});
test("partial verification never proves absence and does not retry uncertain IDs", async () => {
  const h = await scanned();
  h.engine.fetch = async (url, options) => {
    if (options.method === "POST") return json({ status_code: 0 });
    return json({ status_code: 0, itemList: [item("2")] });
  };
  await approved(h); assert.equal(h.engine.state.partial, true); assert.equal(h.engine.snapshot().removed, 0); assert.equal(h.engine.snapshot().uncertain, 1);
  assert.deepEqual(h.engine.prepare({ limit: 5 }).batch.ids, ["2"]);
  h.engine.state.items.push({ id: "1", desc: "", author: "" });
  assert.deepEqual(h.engine.prepare({ limit: 5 }).batch.ids, ["2"]);
});
test("uncertain history is not promoted to removed by absence from a partial rescan", async () => {
  const h = harness({ fetch: async () => json({ status_code: 0, itemList: [item("2")] }) });
  h.engine.state.outcomes["1"] = { status: "uncertain" }; h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.snapshot().removed, 0); assert.equal(h.engine.snapshot().uncertain, 1);
});
test("a present item is positively identified even in partial verification", async () => {
  const h = await scanned(); h.engine.fetch = async (url, options) => options.method === "POST" ? json({ status_code: 0 }) : json({ status_code: 0, itemList: [item("1")] });
  await approved(h); assert.equal(h.engine.snapshot().failed, 1); assert.equal(h.engine.snapshot().removed, 0);
});
test("stop and checkpoint restore revoke partial removal eligibility", async () => {
  const h = harness({ fetch: async () => json({ status_code: 0, itemList: [item("1")] }) }); h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.partial, true);
  const fresh = harness(); fresh.engine.restore({ schema: 1, state: h.saved.at(-1) }); assert.equal(fresh.engine.state.partial, false); assert.throws(() => fresh.engine.prepare({}));
  await h.engine.stop(); assert.equal(h.engine.state.partial, false); assert.throws(() => h.engine.prepare({}));
});
test("a new failed scan cannot authorize stale candidates from the previous scan", async () => {
  const h = await scanned(); h.engine.fetch = async () => json({ status_code: 0 }); h.engine.scan({}); await h.engine.running;
  assert.equal(h.engine.state.items.length, 0); assert.equal(h.engine.state.partial, false); assert.throws(() => h.engine.prepare({}));
});
test("a failed account check at scan start revokes the previous approval immediately", async () => {
  let ctx = context(); const h = await scanned(harness({ context: () => ctx })); const previous = h.engine.prepare({});
  ctx = null; assert.throws(() => h.engine.scan({}), { code: "LOGIN" }); ctx = context();
  assert.equal(h.engine.state.items.length, 0); assert.equal(h.engine.approval, null); assert.throws(() => h.engine.approve(previous.batch.nonce)); assert.throws(() => h.engine.prepare({}));
});
test("multi-page scan deduplicates IDs and handles empty intermediate page", async () => {
  const pages = [listing([item("1")], true, "30"), listing([], true, "60"), listing([item("1"), item("2")])];
  const h = harness({ fetch: async () => pages.shift() }); h.engine.scan({}); await h.engine.running; assert.equal(h.engine.snapshot().remaining, 2); assert.equal(h.engine.state.complete, true);
});
test("repeated Scan and Start cannot create concurrent jobs", async () => {
  const h = harness(); h.engine.scan({}); assert.throws(() => h.engine.scan({}), { code: "BUSY" }); await h.engine.running;
  const s = h.engine.prepare({ delay: 3, limit: 1 }); h.engine.approve(s.batch.nonce); assert.throws(() => h.engine.approve(s.batch.nonce)); assert.throws(() => h.engine.prepare({})); await h.engine.running;
});
test("pause blocks the next request and resume continues only active job", async () => {
  const h = await scanned(); const originalFetch = h.engine.fetch;
  let first; const firstDone = new Promise((r) => { first = r; }); let unblock;
  h.engine.sleep = async (ms, signal) => {
    if (ms === 3000 && !unblock && h.calls.some((call) => call.options.method === "POST")) { h.engine.pause(); first(); await new Promise((r) => { unblock = r; }); }
    if (signal.aborted) throw Error("abort");
  };
  h.engine.fetch = originalFetch;
  const s = h.engine.prepare({ delay: 3, limit: 2 }); h.engine.approve(s.batch.nonce); await firstDone;
  assert.equal(h.calls.filter((c) => c.options.method === "POST").length, 1); assert.equal(h.engine.state.phase, "paused");
  h.engine.resume(); unblock(); await h.engine.running; assert.equal(h.engine.snapshot().removed, 2);
});
test("checkpoint excludes CSRF and approval; restore never starts work", async () => {
  const h = await scanned(); await approved(h);
  const serialized = JSON.stringify(h.saved); assert.ok(!serialized.includes("synthetic-csrf")); assert.ok(!serialized.includes('"nonce"'));
  const restored = harness(); restored.engine.restore({ schema: 1, state: h.saved.at(-1) });
  assert.equal(restored.calls.length, 0); assert.equal(restored.engine.running, null); assert.equal(restored.engine.approval, null); assert.equal(restored.engine.state.complete, false); assert.equal(restored.engine.state.phase, "interrupted"); assert.throws(() => restored.engine.prepare({}));
});
test("interrupted in-flight request is uncertain and reconciled by rescan", async () => {
  const h = harness(); h.engine.restore({ schema: 1, state: { items: [], settings: {}, account: "test-account", outcomes: { "1": { status: "in_flight" } } } }); assert.equal(h.engine.snapshot().uncertain, 1);
  h.remaining.delete("1"); h.engine.scan({}); await h.engine.running; assert.equal(h.engine.snapshot().removed, 1); assert.equal(h.calls.filter((c) => c.options.method === "POST").length, 0);
});
test("checkpoint write failure prevents dispatch", async () => {
  const h = await scanned(); h.engine.persist = async () => { throw Error("storage full"); }; await approved(h); assert.equal(h.calls.filter((c) => c.options.method === "POST").length, 0); assert.equal(h.engine.state.phase, "error");
});
test("accepted deletion still listed is marked failed, not removed", async () => {
  const h = await scanned(); h.engine.fetch = async (url, options) => options.method === "POST" ? json({ status_code: 0 }) : listing(); await approved(h); assert.equal(h.engine.snapshot().removed, 0); assert.equal(h.engine.snapshot().failed, 1);
});
test("verification failure leaves accepted operations uncertain", async () => {
  const h = await scanned(); h.engine.fetch = async (url, options) => options.method === "POST" ? json({ status_code: 0 }) : json({}, 503);
  await approved(h); assert.equal(h.engine.snapshot().removed, 0); assert.equal(h.engine.snapshot().uncertain, 1); assert.equal(h.engine.state.complete, false);
});
test("stop during durable intent checkpoint prevents the pending POST", async () => {
  const h = await scanned(); let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  h.engine.persist = async () => { if (!release) { started(); await new Promise((resolve) => { release = resolve; }); } };
  const s = h.engine.prepare({ delay: 3, limit: 1 }); h.engine.approve(s.batch.nonce); await ready;
  const stopped = h.engine.stop(); release(); await stopped;
  assert.equal(h.calls.filter((call) => call.options.method === "POST").length, 0); assert.equal(h.engine.approval, null);
});
test("timeout also aborts while waiting for the response body", async () => {
  const h = harness({ timeout: 10, fetch: async (url, options) => ({ ok: true, status: 200, text: () => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("body aborted")))) }) });
  h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.phase, "error"); assert.match(h.engine.state.message, /timed out/); assert.equal(h.engine.active.size, 0);
});
test("restored history is cleared on account switch and never authorizes an ID", async () => {
  const h = harness({ context: () => ({ secUid: "new-account" }) }); h.engine.restore({ schema: 1, state: { account: "old-account", items: [], settings: {}, outcomes: { "99": { status: "verified_removed" } } } });
  h.engine.scan({}); await h.engine.running; assert.equal(h.engine.snapshot().removed, 0); assert.equal(h.engine.state.account, "new-account");
});
test("failed preparation cannot mutate an existing approved batch's settings", async () => {
  const h = await scanned(); const before = h.engine.prepare({ delay: 7, limit: 1 });
  assert.throws(() => h.engine.prepare({ delay: 3, limit: 100, keywords: "doesnotmatch" }));
  assert.equal(h.engine.state.settings.delay, 7); assert.equal(h.engine.state.batch.nonce, before.batch.nonce);
});
test("worker command serialization retains one tab lease after worker restart", async () => {
  const store = {}; let injections = 0, queries = 0, listener;
  const chrome = {
    runtime: { id: "own", getURL: (file) => `chrome-extension://own/${file}`, onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: { session: { get: async (key) => ({ [key]: store[key] }), set: async (data) => Object.assign(store, data) } },
    tabs: { query: async () => { queries++; return [{ id: 42, active: true, url: "https://www.tiktok.com/@fixture" }]; } },
    scripting: { executeScript: async (input) => { if (input.files) { injections++; return []; } return [{ result: { channel: "repost-reset-reply", ok: true, state: { phase: "removing" } } }]; } },
  };
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
  const send = () => new Promise((resolve) => listener({ type: "connect" }, { id: "own", url: chrome.runtime.getURL("popup.html") }, resolve));
  vm.runInNewContext(source, { chrome, console, URL });
  const answers = await Promise.all([send(), send(), send()]);
  assert.ok(answers.every((answer) => answer.ok)); assert.equal(injections, 1); assert.equal(queries, 1); assert.equal(store.jobTab, 42);
  vm.runInNewContext(source, { chrome, console, URL }); await send(); assert.equal(injections, 1); assert.equal(queries, 1);
});
test("extension message boundary rejects TikTok page and other extension senders", async () => {
  let listener;
  const chrome = { runtime: { id: "own", getURL: (file) => `chrome-extension://own/${file}`, onMessage: { addListener: (fn) => { listener = fn; } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), { chrome, console, URL });
  for (const sender of [ {}, { id: "other", url: "chrome-extension://own/popup.html" }, { id: "own", url: "https://www.tiktok.com/@fixture", tab: { id: 1 } }, { id: "own", url: "chrome-extension://own/popup.html", frameId: 1 } ]) {
    let reply; assert.equal(listener({ type: "approve", nonce: "forged" }, sender, (value) => { reply = value; }), false); assert.equal(reply.ok, false);
  }
});
test("no page-event bridge, remote code, telemetry or unnecessary permissions", () => {
  const dir = path.join(__dirname, ".."); const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  assert.deepEqual(manifest.permissions, ["scripting", "storage"]); assert.deepEqual(manifest.host_permissions, ["https://www.tiktok.com/*"]); assert.equal(manifest.externally_connectable, undefined); assert.equal(manifest.web_accessible_resources, undefined);
  const agent = fs.readFileSync(path.join(dir, "agent.js"), "utf8"); assert.doesNotMatch(agent, /addEventListener|onMessage|dispatchEvent|postMessage|world:\s*"MAIN"/);
  const production = ["core.js", "agent.js", "background.js", "popup.js"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.doesNotMatch(production, /document\.cookie|chrome\.cookies|localStorage|sessionStorage|sendBeacon|WebSocket|XMLHttpRequest|eval\s*\(|new Function|importScripts|https:\/\/(?!www\.tiktok\.com)/);
  const ui = fs.readFileSync(path.join(dir, "popup.js"), "utf8"); assert.match(ui, /event\.isTrusted/); assert.doesNotMatch(ui, /innerHTML/);
});
