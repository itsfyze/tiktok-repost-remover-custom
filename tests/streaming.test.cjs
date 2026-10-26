"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../core.js");
const response = (data, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(data) });
const video = (id, desc = "travel") => ({ id: String(id), desc, author: { uniqueId: "fixture" } });
const page = (items, more = false, cursor = "0") => response({ status_code: 0, itemList: items, hasMore: more, cursor });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw Error("Timed out waiting for engine state"); await tick(); }
}
function harness({ ids = [1, 2, 3, 4], fetch: override, persist, timeout = 20000 } = {}) {
  const trace = [], saved = [], remaining = ids.map((id) => video(id));
  let serial = 0, getCount = 0;
  const h = { trace, saved, remaining };
  h.engine = new Engine({ context: () => ({ secUid: "fixture-account", csrfToken: "fake-csrf-only" }), uuid: () => `request-${++serial}`, timeout,
    sleep: async (ms, signal) => { await tick(); if (signal.aborted) throw Error("aborted"); },
    persist: persist || (async (state) => { saved.push(state); }),
    fetch: async (url, options) => {
      assert.equal(h.engine.active.size, 1, "Listing and deletion requests must not overlap");
      const parsed = new URL(url);
      trace.push({ method: options.method, cursor: parsed.searchParams.get("cursor"), id: parsed.searchParams.get("item_id"), signal: options.signal });
      if (options.method === "GET") getCount++;
      if (override) return override({ url: parsed, options, getCount, h });
      if (options.method === "POST") { const index = remaining.findIndex((item) => item.id === parsed.searchParams.get("item_id")); if (index >= 0) remaining.splice(index, 1); return response({ status_code: 0 }); }
      const cursor = Number(parsed.searchParams.get("cursor"));
      return page(remaining.slice(cursor, cursor + 2), cursor + 2 < remaining.length, String(cursor + 2));
    },
  });
  return h;
}
function stalledScan() {
  let started, aborted = false;
  const ready = new Promise((resolve) => { started = resolve; });
  const h = harness({ fetch: ({ options, getCount, url, h }) => {
    if (options.method === "POST") { h.remaining.splice(h.remaining.findIndex((item) => item.id === url.searchParams.get("item_id")), 1); return response({ status_code: 0 }); }
    if (getCount === 1) return page(h.remaining.slice(0, 2), true, "2");
    if (getCount === 2) return new Promise((resolve, reject) => { started(); options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }); });
    return page(h.remaining);
  } });
  h.engine.scan({ delay: 3, limit: 1 });
  return { h, ready, wasAborted: () => aborted };
}
async function approveAll(h, limit = 30) {
  const batches = [];
  for (let count = 0; count < limit; count++) {
    await until(() => h.engine.state.phase === "awaiting" || !h.engine.running);
    if (!h.engine.running) return batches;
    const batch = h.engine.snapshot().batch;
    batches.push(batch);
    h.engine.approve(batch.nonce);
    assert.throws(() => h.engine.approve(batch.nonce), { code: "UNAUTHORIZED" });
    await until(() => !h.engine.running || (h.engine.state.phase === "awaiting" && h.engine.state.batch.nonce !== batch.nonce));
  }
  throw Error("Too many test batches");
}
test("Stop during a later scan request retains validated videos without granting deletion", async () => {
  const { h, ready, wasAborted } = stalledScan(); await ready;
  assert.equal(h.engine.snapshot().canRemoveFoundNow, true); assert.deepEqual(h.engine.state.items.map((item) => item.id), ["1", "2"]);
  await h.engine.stop(); assert.equal(wasAborted(), true); assert.equal(h.engine.active.size, 0); assert.equal(h.engine.state.phase, "partial");
  assert.equal(h.engine.state.complete, false); assert.equal(h.engine.approval, null); assert.equal(h.trace.filter((call) => call.method === "POST").length, 0);
  assert.deepEqual(h.engine.prepare({ limit: 1 }).batch.ids, ["1"]);
});
test("Remove found so far drains the scanner then prepares an exact batch", async () => {
  const { h, ready, wasAborted } = stalledScan(); await ready;
  const prepared = await h.engine.prepareFound({ delay: 3, limit: 1 });
  assert.equal(wasAborted(), true); assert.equal(h.engine.running, null); assert.deepEqual(prepared.batch.ids, ["1"]);
  assert.equal(h.trace.filter((call) => call.method === "POST").length, 0);
  h.engine.approve(prepared.batch.nonce); await h.engine.running;
  assert.equal(h.engine.snapshot().removed, 1); assert.equal(h.engine.active.size, 0);
  assert.equal(h.engine.snapshot().total, 4, "Verification includes newly discovered IDs in the found count");
});
test("paused scans also keep already discovered videos on Stop", async () => {
  const { h, ready } = stalledScan(); await ready; h.engine.pause();
  assert.equal(h.engine.snapshot().canKeepScanResults, true); await h.engine.stop(); assert.equal(h.engine.state.phase, "partial"); assert.equal(h.engine.snapshot().actionable, 2);
});
test("Stop before the first valid result cannot authorize anything", async () => {
  const h = harness({ fetch: ({ options }) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort")))) });
  h.engine.scan({}); await until(() => h.engine.active.size > 0); await h.engine.stop();
  assert.equal(h.engine.state.phase, "stopped"); assert.throws(() => h.engine.prepare({}));
});
test("scan-and-remove waits on the first page; discovery is not prior blanket consent", async () => {
  const h = harness(); h.engine.scanAndRemove({ delay: 3, limit: 1 });
  await until(() => h.engine.state.phase === "awaiting");
  assert.equal(h.trace.length, 1); assert.equal(h.trace[0].method, "GET"); assert.equal(h.engine.snapshot().batch.progressive, true); assert.equal(h.engine.state.complete, false);
  assert.throws(() => h.engine.approve("page-forgery"), { code: "UNAUTHORIZED" }); await tick(); assert.equal(h.trace.length, 1);
  await h.engine.stop(); assert.equal(h.engine.state.phase, "partial"); assert.equal(h.engine.approvalWaiter, null); assert.equal(h.engine.running, null);
});
test("progressive batches each require a new nonce and never overlap network requests", async () => {
  const h = harness(); h.engine.scanAndRemove({ delay: 3, limit: 1 });
  const batches = await approveAll(h);
  assert.equal(batches.length, 4); assert.equal(new Set(batches.map((batch) => batch.nonce)).size, 4);
  assert.deepEqual(batches.flatMap((batch) => batch.ids), ["1", "2", "3", "4"]);
  assert.deepEqual(h.trace.filter((call) => call.method === "POST").map((call) => call.id), ["1", "2", "3", "4"]);
  assert.equal(h.engine.snapshot().removed, 4); assert.equal(h.engine.snapshot().remaining, 0); assert.equal(h.engine.active.size, 0);
});
test("mutating cursor pagination restarts at zero so shifted reposts are not skipped", async () => {
  const h = harness({ ids: [1, 2, 3, 4, 5, 6, 7] }); h.engine.scanAndRemove({ limit: 2, delay: 3 });
  const batches = await approveAll(h);
  assert.equal(h.trace.filter((call) => call.method === "POST").length, 7);
  assert.equal(batches.length, 4); assert.ok(batches.every((batch) => batch.size <= 2));
  assert.ok(h.trace.filter((call) => call.method === "GET").every((call) => call.cursor === "0")); assert.equal(h.engine.snapshot().removed, 7);
});
test("an expired progressive approval cannot dispatch a POST", async () => {
  const h = harness(); h.engine.scanAndRemove({}); await until(() => h.engine.state.phase === "awaiting");
  h.engine.approval.expires = 0; assert.throws(() => h.engine.approve(h.engine.state.batch.nonce), { code: "UNAUTHORIZED" });
  assert.equal(h.trace.filter((call) => call.method === "POST").length, 0); await h.engine.stop();
});
test("repeated streaming start and manual prepare cannot create a second job", async () => {
  const h = harness(); h.engine.scanAndRemove({}); await until(() => h.engine.state.phase === "awaiting");
  assert.throws(() => h.engine.scanAndRemove({}), { code: "BUSY" }); assert.throws(() => h.engine.scan({}), { code: "BUSY" });
  await assert.rejects(h.engine.prepareFound({}), { code: "BUSY" }); await h.engine.stop();
});
test("Stop while awaiting the next streamed batch cancels approval and keeps other known results", async () => {
  const h = harness(); h.engine.scanAndRemove({ limit: 1, delay: 3 }); await until(() => h.engine.state.phase === "awaiting");
  const old = h.engine.state.batch.nonce; h.engine.approve(old);
  await until(() => h.engine.state.phase === "awaiting" && h.engine.state.batch.nonce !== old);
  const unused = h.engine.state.batch.nonce; await h.engine.stop();
  assert.equal(h.engine.state.phase, "partial"); assert.equal(h.engine.snapshot().uncertain, 1); assert.throws(() => h.engine.approve(unused), { code: "UNAUTHORIZED" });
  assert.deepEqual(h.engine.prepare({ limit: 5 }).batch.ids, ["2"]);
  assert.equal(h.trace.filter((call) => call.method === "POST").length, 1);
});
test("Stop during streamed POST aborts it and never resumes remaining deletions", async () => {
  let postStarted; const ready = new Promise((resolve) => { postStarted = resolve; }); let aborted = false;
  const h = harness({ fetch: ({ options, h }) => options.method === "GET" ? page(h.remaining) : new Promise((resolve, reject) => { postStarted(); options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("abort")); }); }) });
  h.engine.scanAndRemove({ limit: 2 }); await until(() => h.engine.state.phase === "awaiting"); h.engine.approve(h.engine.state.batch.nonce); await ready; await h.engine.stop();
  assert.equal(aborted, true); assert.equal(h.engine.state.phase, "stopped"); assert.equal(h.engine.active.size, 0); assert.equal(h.engine.snapshot().uncertain, 1); assert.equal(h.trace.filter((call) => call.method === "POST").length, 1); assert.throws(() => h.engine.resume());
});
test("rate-limited streamed deletion halts rather than asking for another batch", async () => {
  const h = harness({ fetch: ({ options, h }) => options.method === "GET" ? page(h.remaining) : response({}, 429) });
  h.engine.scanAndRemove({ limit: 1 }); await until(() => h.engine.state.phase === "awaiting"); h.engine.approve(h.engine.state.batch.nonce); await h.engine.running;
  assert.equal(h.engine.state.phase, "rate_limited"); assert.equal(h.engine.state.partial, false); assert.equal(h.engine.approval, null); assert.throws(() => h.engine.prepare({})); assert.throws(() => h.engine.scan({}), { code: "COOLDOWN" });
});
test("session and transport errors after discoveries do not enable keep-and-remove", async () => {
  for (const failed of [response({}, 403), response({ status_code: 123 }), { ok: true, status: 200, text: async () => "<html>challenge</html>" }]) {
    const h = harness({ fetch: ({ getCount, h }) => getCount === 1 ? page(h.remaining.slice(0, 2), true, "2") : failed });
    h.engine.scan({}); await h.engine.running; assert.equal(h.engine.state.phase, "error"); await h.engine.stop(); assert.equal(h.engine.state.partial, false); assert.throws(() => h.engine.prepare({}));
  }
});
test("progressive keyword filtering never expands an approval to unrelated videos", async () => {
  const h = harness(); h.remaining[0].desc = "cats"; h.remaining[2].desc = "cats";
  h.engine.scanAndRemove({ limit: 1, keywords: "cats" }); const batches = await approveAll(h);
  assert.deepEqual(batches.flatMap((batch) => batch.ids), ["1", "3"]); assert.deepEqual(h.remaining.map((item) => item.id), ["2", "4"]);
});
test("no-match progressive mode is read-only and terminates without confirmation", async () => {
  const h = harness(); h.engine.scanAndRemove({ keywords: "doesnotmatch" }); await h.engine.running;
  assert.equal(h.engine.state.phase, "ready"); assert.equal(h.trace.filter((call) => call.method === "POST").length, 0); assert.equal(h.engine.snapshot().remaining, 4);
});
test("streaming checkpoints cannot restore an approval or automatic discovery/removal loop", async () => {
  const h = harness(); h.engine.scanAndRemove({ limit: 1 }); await until(() => h.engine.state.phase === "awaiting"); h.engine.approve(h.engine.state.batch.nonce);
  await until(() => h.engine.state.phase === "awaiting");
  const saved = h.saved.at(-1); assert.ok(saved); assert.equal(saved.batch, undefined); assert.equal(saved.progressive, undefined); assert.equal(JSON.stringify(saved).includes("fake-csrf-only"), false);
  const restored = harness(); restored.engine.restore({ schema: 1, state: saved }); assert.equal(restored.engine.running, null); assert.equal(restored.engine.progressive, false); assert.equal(restored.trace.length, 0); assert.throws(() => restored.engine.prepare({})); await h.engine.stop();
});

test("pausing an approved streamed batch prevents its first dispatch until resumed", async () => {
  const h = harness(); h.engine.scanAndRemove({ limit: 1 });
  await until(() => h.engine.state.phase === "awaiting"); h.engine.approve(h.engine.state.batch.nonce); h.engine.pause();
  await tick(); await tick(); assert.equal(h.trace.filter((call) => call.method === "POST").length, 0);
  h.engine.resume(); await until(() => h.engine.state.phase === "awaiting");
  assert.equal(h.trace.filter((call) => call.method === "POST").length, 1); await h.engine.stop();
});

test("failed streaming intent storage prevents a deletion", async () => {
  const h = harness({ persist: async () => { throw Error("storage unavailable"); } });
  h.engine.scanAndRemove({}); await until(() => h.engine.state.phase === "awaiting"); h.engine.approve(h.engine.state.batch.nonce); await h.engine.running;
  assert.equal(h.trace.filter((call) => call.method === "POST").length, 0); assert.equal(h.engine.state.phase, "error"); assert.equal(h.engine.approval, null);
});

test("Stop racing an account-context failure cannot restore partial eligibility", async () => {
  const h = harness(); let resolveStop; const stopped = new Promise((resolve) => { resolveStop = resolve; }); let queued = false;
  h.engine.context = () => {
    if (h.trace.length && !queued) {
      queued = true; queueMicrotask(() => h.engine.stop().then(resolveStop));
      return { secUid: "different-account", csrfToken: "fake-other-csrf" };
    }
    return { secUid: "fixture-account", csrfToken: "fake-csrf-only" };
  };
  h.engine.scan({}); await stopped;
  assert.equal(h.engine.state.partial, false); assert.throws(() => h.engine.prepare({})); assert.equal(h.trace.length, 1);
});
