"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
function harness({ state = { version: "1.0.3", phase: "removing", items: [] }, missing = false, execute, tabs = [{ id: 42, active: true, url: "https://www.tiktok.com/@fixture" }] } = {}) {
  let listener;
  const h = { store: { jobTab: 42 }, calls: [], injections: 0, queries: 0 };
  const agent = { command: async () => state };
  const chrome = {
    runtime: { id: "own", getURL: (file) => `chrome-extension://own/${file}`, onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: { session: { get: async (key) => ({ [key]: h.store[key] }), set: async (data) => Object.assign(h.store, data) } },
    tabs: { query: async () => { h.queries++; return tabs; } },
    scripting: { executeScript: async (input) => {
      if (input.files) { h.injections++; sandbox.RepostAgent = agent; return []; }
      h.calls.push({ tabId: input.target.tabId, command: input.args[0] });
      if (execute) { const result = await execute(input, h); if (result) return result; }
      // Model Chrome losing uncaught execution errors instead of rejecting.
      try { return [{ result: JSON.parse(JSON.stringify(await input.func(...input.args))) }]; }
      catch { return [{ result: undefined }]; }
    } },
  };
  const sandbox = { chrome, console, URL, RepostAgent: missing ? undefined : agent };
  vm.runInNewContext(source, sandbox);
  h.agent = agent; h.sandbox = sandbox;
  h.send = (type, extra = {}, sender = { id: "own", url: chrome.runtime.getURL("popup.html") }) => new Promise((resolve) => listener({ type, ...extra }, sender, resolve));
  return h;
}
test("injected command errors survive Chrome's undefined-result exception behavior", async () => {
  const h = harness(); h.agent.command = async () => { throw Object.assign(new Error("Account changed; rescan first."), { code: "ACCOUNT_CHANGED" }); };
  const answer = await h.send("prepare"); assert.equal(answer.ok, false); assert.equal(answer.code, "ACCOUNT_CHANGED"); assert.match(answer.error, /Account changed/); assert.equal(h.calls.length, 1);
});
test("unknown injected exceptions return a bounded error without exposing arbitrary error data", async () => {
  const h = harness(); h.agent.command = async () => { throw Error("secret-fixture-do-not-display"); };
  const answer = await h.send("state"); assert.equal(answer.code, "AGENT_ERROR"); assert.doesNotMatch(answer.error, /secret-fixture/); assert.equal(h.calls.length, 1);
});
test("one missing status reply is retried as a read only", async () => {
  const h = harness({ execute: (input, h) => h.calls.length === 1 ? [{ result: undefined }] : null });
  const answer = await h.send("state"); assert.equal(answer.ok, true); assert.equal(h.calls.length, 2); assert.ok(h.calls.every((call) => call.command.type === "state")); assert.equal(h.injections, 0);
});
test("transient failure cannot move a live lease to another active TikTok tab", async () => {
  const h = harness({ execute: () => [{ result: undefined }], tabs: [{ id: 42, active: false }, { id: 77, active: true }] });
  const status = await h.send("state"); assert.equal(status.code, "CONNECTION");
  const reconnect = await h.send("connect"); assert.equal(reconnect.code, "CONNECTION"); assert.equal(h.store.jobTab, 42); assert.equal(h.injections, 0); assert.ok(h.calls.every((call) => call.tabId === 42));
});
test("a lost approval response never resends a possibly applied action", async () => {
  let applied = 0;
  const h = harness({ execute: (input) => { if (input.args[0].type === "approve") { applied++; return [{ result: undefined }]; } } });
  const answer = await h.send("approve", { nonce: "exact-existing-batch" }); assert.equal(answer.code, "CONNECTION"); assert.equal(applied, 1);
  assert.equal((await h.send("connect")).ok, true); assert.equal(applied, 1); assert.equal(h.injections, 0);
});
test("reconnect reads the existing job without recreating its agent or authority", async () => {
  const h = harness({ state: { version: "1.0.3", phase: "removing", items: [], batch: { nonce: "existing", ids: ["1"], completed: 1 } } });
  const answer = await h.send("connect"); assert.equal(answer.ok, true); assert.equal(answer.state.batch.nonce, "existing"); assert.equal(h.injections, 0); assert.equal(h.queries, 0); assert.deepEqual(h.calls.map((call) => call.command.type), ["state"]);
});
test("status transfer omits full scan history and includes only reviewed batch descriptions", async () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: String(i + 1), desc: "fixture ".repeat(100) }));
  const h = harness({ state: { version: "1.0.3", phase: "awaiting", items, outcomes: { "1": { status: "uncertain" } }, total: 5000, actionable: 4999, batch: { ids: ["2", "3"] } } });
  const answer = await h.send("state"); assert.equal(answer.ok, true); assert.deepEqual(Array.from(answer.state.items, (item) => item.id), ["2", "3"]); assert.equal(answer.state.outcomes, undefined); assert.equal(answer.state.total, 5000); assert.equal(answer.state.actionable, 4999); assert.ok(JSON.stringify(answer).length < 3000);
});
test("missing isolated agent is reported explicitly; reconnect reinjects only in the same tab", async () => {
  const h = harness({ missing: true, state: { version: "1.0.3", phase: "interrupted", items: [] } });
  assert.equal((await h.send("state")).code, "AGENT_MISSING"); const answer = await h.send("connect");
  assert.equal(answer.ok, true); assert.equal(answer.state.phase, "interrupted"); assert.equal(h.injections, 1); assert.equal(h.store.jobTab, 42); assert.equal(h.queries, 0); assert.ok(h.calls.every((call) => call.command.type === "state"));
});
test("a closed former tab can be replaced without dispatching any account action", async () => {
  const h = harness({ tabs: [{ id: 77, active: true }], execute: (input) => { if (input.target.tabId === 42) throw Error("No tab with this ID"); } });
  const answer = await h.send("connect"); assert.equal(answer.ok, true); assert.equal(h.store.jobTab, 77); assert.equal(h.injections, 1); assert.ok(h.calls.every((call) => call.command.type === "state"));
});
test("a lost Stop response is not retried and a later read reports the stopped job", async () => {
  const state = { version: "1.0.3", phase: "removing", items: [] }; let stopped = 0;
  const h = harness({ state, execute: (input) => { if (input.args[0].type === "stop") { stopped++; state.phase = "stopped"; return [{ result: undefined }]; } } });
  assert.equal((await h.send("stop")).code, "CONNECTION"); assert.equal(stopped, 1); assert.equal((await h.send("state")).state.phase, "stopped"); assert.equal(stopped, 1);
});

test("standalone dashboard sender works when Chrome omits tab URL metadata", async () => {
  const h = harness();
  const answer = await h.send("state", {}, { id: "own", url: "chrome-extension://own/popup.html", frameId: 0, tab: { id: 900 } });
  assert.equal(answer.ok, true); assert.equal(answer.state.phase, "removing"); assert.equal(h.calls[0].tabId, 42);
});

test("popup and standalone dashboard share the same leased job", async () => {
  const h = harness(); await h.send("connect");
  const answer = await h.send("connect", {}, { id: "own", url: "chrome-extension://own/popup.html", frameId: 0, tab: { id: 900 } });
  assert.equal(answer.ok, true); assert.equal(h.injections, 0); assert.equal(h.queries, 0); assert.ok(h.calls.every((call) => call.tabId === 42));
});

test("dashboard support does not allow TikTok, local HTML, other extensions or subframes", async () => {
  const h = harness();
  for (const sender of [
    { id: "own", url: "https://www.tiktok.com/@fixture", frameId: 0, tab: { id: 42 } },
    { id: "own", url: "file:///C:/fixture/popup.html", frameId: 0, tab: { id: 900 } },
    { id: "other", url: "chrome-extension://own/popup.html", frameId: 0, tab: { id: 900 } },
    { id: "own", url: "chrome-extension://own/popup.html", frameId: 1, tab: { id: 900 } },
  ]) assert.equal((await h.send("approve", { nonce: "forged" }, sender)).ok, false);
  assert.equal(h.calls.length, 0);
});
