"use strict";
// Optional development-only browser integration. Uses an already installed
// Chrome and an already available Playwright; downloads nothing. No real login.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const moduleRoot = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(moduleRoot);
const root = path.resolve(__dirname, "..");
const output = path.resolve(process.env.TEST_OUTPUT || path.join(root, "../runtime-validation"));
const partialFixture = process.env.REPOST_PARTIAL_FIXTURE === "1";
const interactiveFixture = process.env.REPOST_INTERACTIVE_FIXTURE || "";
const connectionMode = process.env.REPOST_CONNECTION_FIXTURE || "";
const connectionFixture = ["1", "stop"].includes(connectionMode);
const dashboardFixture = process.env.REPOST_DASHBOARD_FIXTURE === "1";
const listFixture = process.env.REPOST_LIST_FIXTURE || "";
let missingListSent = false;
if (interactiveFixture && !["stream", "stop", "switch"].includes(interactiveFixture)) throw Error("Unknown interactive fixture");
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  const requests = [], errors = [];
  let posts = 0;
  let remaining = [{ id: "1000000000000000001", desc: "A quiet morning in the city", author: { uniqueId: "fixture" } }, { id: "1000000000000000002", desc: "Travel notes", author: { uniqueId: "fixture" } }];
  if (connectionFixture || dashboardFixture) remaining = Array.from({ length: 5 }, (_, i) => ({ id: `100000000000000000${i + 1}`, desc: `Integration fixture ${i + 1}`, author: { uniqueId: "fixture" } }));
  let loseStatusReplies = false;
  const checkpointStore = {}, sessionStore = {};
  let firstManualScan = interactiveFixture === "stop" || interactiveFixture === "switch";
  let releaseListing;
  let listingStarted;
  const listingReady = new Promise((resolve) => { listingStarted = resolve; });
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.protocol === "file:") return route.continue();
      requests.push({ host: url.hostname, path: url.pathname, method: request.method() });
      assert.equal(url.origin, "https://www.tiktok.com", "Unexpected network destination in isolated test");
      if (url.pathname === "/@fixture") return route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Mock TikTok — no account</title><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"user":{"secUid":"fixture-account"},"csrfToken":"fixture-only"}}}</script><h1>Mock account only</h1>' });
      if (url.pathname === "/api/repost/item_list/" && firstManualScan && url.searchParams.get("cursor") === "1") {
        listingStarted();
        await new Promise((resolve) => { releaseListing = resolve; });
        // This route is deliberately held while the user-facing Stop cancels it.
        // No request is sent to TikTok, including when the route is cancelled.
        if (request.failure()) return;
        return route.abort();
      }
      if (url.pathname === "/api/repost/item_list/" && (interactiveFixture === "stream" || firstManualScan)) {
        const cursor = Number(url.searchParams.get("cursor"));
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status_code: 0, itemList: remaining.slice(cursor, cursor + 1), hasMore: cursor + 1 < remaining.length, cursor: String(cursor + 1) }) });
      }
      if (url.pathname === "/api/repost/item_list/" && listFixture) {
        if (listFixture === "transient" && !missingListSent) { missingListSent = true; return route.fulfill({ contentType: "application/json", body: '{"status_code":0}' }); }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status_code: 0, data: { item_list: remaining, has_more: false, cursor: "0" } }) });
      }
      if (url.pathname === "/api/repost/item_list/") return route.fulfill({ contentType: "application/json", body: JSON.stringify(
        partialFixture && url.searchParams.get("cursor") === "30" ? { status_code: 0 }
          : { status_code: 0, itemList: remaining, hasMore: partialFixture, cursor: partialFixture ? "30" : "0" }
      ) });
      if (url.pathname === "/tiktok/v1/upvote/delete") {
        assert.equal(request.method(), "POST"); assert.equal(request.headers()["tt-csrf-token"], "fixture-only"); posts++;
        remaining = remaining.filter((item) => item.id !== url.searchParams.get("item_id"));
        return route.fulfill({ contentType: "application/json", body: '{"status_code":0}' });
      }
      return route.abort();
    });
    const tiktok = await context.newPage();
    const client = await context.newCDPSession(tiktok);
    await client.send("Page.enable");
    await client.send("Page.addScriptToEvaluateOnNewDocument", { worldName: "repost-test-isolated", source: "globalThis.chrome={storage:{local:{get:async()=>({}),set:async()=>{}}}};" });
    await tiktok.goto("https://www.tiktok.com/@fixture");
    const tree = await client.send("Page.getFrameTree");
    const isolated = await client.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "repost-test-isolated" });
    const evaluate = async (expression) => {
      const result = await client.send("Runtime.evaluate", { expression, contextId: isolated.executionContextId, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    let listener;
    const chrome = {
      runtime: { id: "fixture-extension", getURL: (file) => `chrome-extension://fixture-extension/${file}`, onMessage: { addListener: (fn) => { listener = fn; } } },
      storage: { session: { get: async (key) => ({ [key]: sessionStore[key] }), set: async (values) => Object.assign(sessionStore, values) }, local: { get: async (key) => ({ [key]: checkpointStore[key] }) } },
      tabs: { query: async () => [{ id: 1, active: true, url: "https://www.tiktok.com/@fixture" }] },
      scripting: { executeScript: async (input) => {
        assert.equal(input.world, "ISOLATED"); assert.deepEqual(Array.from(input.target.frameIds), [0]);
        if (input.files) {
          for (const file of input.files) await evaluate(fs.readFileSync(path.join(root, file), "utf8"));
          return [{ result: null }];
        }
        if (loseStatusReplies && input.args[0].type === "state") return [{ result: undefined }];
        return [{ result: await evaluate(`(${input.func.toString()})(${JSON.stringify(input.args[0])})`) }];
      } },
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), { chrome, console, URL });
    let dashboard;
    const makeUI = async (inTab) => {
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.exposeFunction("repostTestMessage", (command) => new Promise((resolve) => listener(command, { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html"), frameId: 0, ...(inTab ? { tab: { id: 900 } } : {}) }, resolve)));
      await page.exposeFunction("repostTestExpand", async () => { dashboard = await makeUI(true); return { id: 900 }; });
      await page.addInitScript(() => { window.chrome.runtime = { sendMessage: (command) => window.repostTestMessage(command), getURL: (file) => file }; window.chrome.tabs = { create: (input) => window.repostTestExpand(input) }; });
      await page.goto("file:///" + path.join(root, "popup.html").replaceAll("\\", "/"));
      return page;
    };
    const popup = await makeUI(false);
    await popup.getByRole("button", { name: "Connect", exact: true }).click();
    if (dashboardFixture) {
      await popup.locator("#expand").click();
      const deadline = Date.now() + 10000;
      while (!dashboard) { if (Date.now() > deadline) throw Error("Expand did not open dashboard"); await new Promise((resolve) => setTimeout(resolve, 25)); }
      await popup.close();
      await dashboard.waitForFunction(() => !document.getElementById("scan").disabled, null, { timeout: 5000 });
      await dashboard.locator("#scan").click();
      await dashboard.waitForFunction(() => document.getElementById("phase").textContent === "ready"); assert.equal(posts, 0);
      await dashboard.locator("#prepare").click(); assert.equal(await dashboard.locator("#video-list li").count(), 5);
      await dashboard.locator("#ack").check(); await dashboard.locator("#approve").click();
      await dashboard.waitForFunction(() => document.getElementById("status").textContent.includes("accepted 1 of 5"));
      await dashboard.screenshot({ path: path.join(output, "dashboard-after-first.png"), fullPage: true });
      await dashboard.waitForFunction(() => document.getElementById("phase").textContent === "ready", null, { timeout: 35000 });
      assert.equal(posts, 5); assert.equal(await dashboard.locator("#removed").textContent(), "5"); assert.deepEqual(errors, []);
      await dashboard.screenshot({ path: path.join(output, "dashboard-five-verified.png"), fullPage: true });
      const result = { passed: true, dashboardFixture: true, listFixture, browser: await browser.version(), mode: "Chrome with mocked extension APIs/TikTok. Popup Expand opens a separate dashboard; popup closes; dashboard sender omits tab URL; five exact fixture removals complete and verify. No real account actions or extension registration.", posts, errors, requests };
      fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); return;
    }
    if (connectionFixture) {
      await popup.locator("#scan").click();
      await popup.waitForFunction(() => document.getElementById("phase").textContent === "ready");
      await popup.locator("#prepare").click(); await popup.locator("#ack").check(); await popup.locator("#approve").click();
      await popup.waitForFunction(() => document.getElementById("status").textContent.includes("accepted 1 of 5"));
      loseStatusReplies = true;
      await popup.waitForFunction(() => document.getElementById("phase").textContent === "connection lost");
      assert.equal(await popup.locator("#connect").isEnabled(), true); assert.equal(await popup.locator("#stop").isEnabled(), true);
      assert.equal(await popup.locator("#stop").textContent(), "Try to stop");
      assert.equal(await popup.locator("#prepare").isDisabled(), true);
      await popup.screenshot({ path: path.join(output, "connection-lost.png"), fullPage: true });
      if (connectionMode === "stop") {
        await popup.locator("#stop").click();
        await popup.waitForFunction(() => document.getElementById("phase").textContent === "stopped");
        assert.equal(posts, 1); assert.equal(await popup.locator("#failed").textContent(), "0 / 1");
        assert.equal(await popup.locator("#resume").isDisabled(), true); assert.deepEqual(errors, []);
        await popup.screenshot({ path: path.join(output, "stopped-during-lost-status.png"), fullPage: true });
        const result = { passed: true, connectionFixture: "stop", browser: await browser.version(), mode: "Fresh Chrome with mocked APIs/TikTok. Try to stop works while status replies are missing, aborts after one accepted request and excludes uncertain work from retry. No real account actions.", posts, errors, requests };
        fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); return;
      }
      loseStatusReplies = false; await popup.getByRole("button", { name: "Reconnect", exact: true }).click();
      assert.equal(await popup.locator("#error").isHidden(), true);
      await popup.waitForFunction(() => document.getElementById("phase").textContent === "ready", null, { timeout: 35000 });
      assert.equal(posts, 5); assert.equal(await popup.locator("#removed").textContent(), "5");
      assert.equal(await popup.locator("#remaining").textContent(), "0"); assert.deepEqual(errors, []);
      await popup.screenshot({ path: path.join(output, "recovered-five-removed.png"), fullPage: true });
      const result = { passed: true, connectionFixture: true, browser: await browser.version(), mode: "Fresh Chrome with mocked APIs and TikTok; lost status replies after first of five removals, recovered same live job, all five verified. No real requests or account actions.", posts, errors, requests };
      fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); return;
    }
    if (interactiveFixture) {
      await popup.locator("#delay").fill("3");
      if (interactiveFixture === "stream") {
        await popup.locator("#scan-remove").click();
        await popup.waitForFunction(() => document.getElementById("phase").textContent === "awaiting");
        assert.equal(posts, 0);
        assert.equal(requests.filter((entry) => entry.path === "/api/repost/item_list/").length, 1);
        assert.match(await popup.locator("#approval-summary").textContent(), /discovery continues/);
        await popup.locator("#ack").check();
        await popup.locator("#approve").evaluate((button) => button.click());
        assert.equal(posts, 0);
        await popup.screenshot({ path: path.join(output, "stream-first-batch.png"), fullPage: true });
        await popup.setViewportSize({ width: 420, height: 600 });
        assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await popup.screenshot({ path: path.join(output, "stream-narrow.png"), fullPage: true });
        await popup.setViewportSize({ width: 900, height: 1200 });
        await popup.locator("#approve").click();
        await popup.waitForFunction(() => document.getElementById("phase").textContent === "awaiting" && document.getElementById("video-list").textContent.includes("1000000000000000002"));
        assert.equal(posts, 1);
        assert.equal(await popup.locator("#ack").isChecked(), false);
        assert.equal(await popup.locator("#approve").isDisabled(), true);
        await popup.screenshot({ path: path.join(output, "stream-next-batch.png"), fullPage: true });
        await popup.locator("#ack").check(); await popup.locator("#approve").click();
        await popup.waitForFunction(() => document.getElementById("phase").textContent === "ready");
        assert.equal(posts, 2); assert.equal(await popup.locator("#removed").textContent(), "2");
      } else {
        await popup.locator("#scan").click();
        await listingReady;
        await popup.waitForFunction(() => document.getElementById("prepare").textContent === "Remove found so far…" && !document.getElementById("prepare").disabled);
        await popup.screenshot({ path: path.join(output, "live-scan-results.png"), fullPage: true });
        if (interactiveFixture === "stop") {
          await popup.locator("#stop").click();
          await popup.waitForFunction(() => document.getElementById("phase").textContent === "partial");
          assert.equal(posts, 0); assert.equal(await popup.locator("#prepare").isEnabled(), true);
          await popup.locator("#prepare").click();
        } else await popup.locator("#prepare").click();
        await popup.waitForFunction(() => document.getElementById("phase").textContent === "awaiting");
        firstManualScan = false;
        releaseListing();
        assert.equal(posts, 0); assert.equal(await popup.locator("#video-list li").count(), 1);
        const state = await evaluate("RepostAgent.command({type:'state'})");
        assert.equal(state.activeRequests, 0, "The scan must settle before deletion is authorized");
        await popup.locator("#ack").check(); await popup.locator("#approve").click();
        await popup.waitForFunction(() => document.getElementById("phase").textContent === "ready");
        assert.equal(posts, 1); assert.equal(await popup.locator("#removed").textContent(), "1");
      }
      assert.deepEqual(errors, []);
      await popup.screenshot({ path: path.join(output, "completed.png"), fullPage: true });
      const result = { passed: true, interactiveFixture, browser: await browser.version(), mode: "Real Chrome UI and isolated-world integration with only mocked TikTok responses and Chrome extension APIs; no account actions.", posts, requests, errors };
      fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    await popup.getByRole("button", { name: "Scan reposts · dry run", exact: true }).click();
    await popup.waitForFunction((phase) => document.getElementById("phase").textContent === phase, partialFixture ? "partial" : "ready");
    assert.equal(posts, 0);
    assert.equal(await tiktok.evaluate(() => typeof globalThis.RepostAgent), "undefined");
    await tiktok.evaluate(() => { window.dispatchEvent(new CustomEvent("trr-remove-repost", { detail: { itemId: "1000000000000000001" } })); window.postMessage({ type: "approve", nonce: "forged" }, "*"); });
    assert.equal(posts, 0);
    await popup.screenshot({ path: path.join(output, "dashboard.png"), fullPage: true });
    await popup.setViewportSize({ width: 420, height: 600 });
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await popup.screenshot({ path: path.join(output, "popup-narrow.png"), fullPage: true });
    await popup.setViewportSize({ width: 900, height: 1200 });
    if (partialFixture) {
      assert.equal(await popup.locator("#total").textContent(), "2+");
      assert.equal(await popup.locator("#remaining").textContent(), "—");
      await popup.locator("#limit").selectOption("custom");
      await popup.locator("#custom").fill("1");
    }
    await popup.getByRole("button", { name: "Start removing…", exact: true }).click();
    assert.equal(posts, 0);
    assert.equal(await popup.getByRole("button", { name: "Confirm removal", exact: true }).isDisabled(), true);
    if (partialFixture) assert.match(await popup.locator("#approval-summary").textContent(), /scan is partial/);
    await popup.locator("#ack").check();
    // Synthetic JS events cannot confirm even with checkbox selected.
    await popup.locator("#approve").evaluate((button) => button.click());
    assert.equal(posts, 0);
    await popup.screenshot({ path: path.join(output, "batch-review.png"), fullPage: true });
    await popup.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await popup.waitForFunction((phase) => document.getElementById("phase").textContent === phase, partialFixture ? "partial" : "ready", { timeout: 30000 });
    assert.equal(posts, partialFixture ? 1 : 2);
    assert.equal(await popup.locator("#removed").textContent(), partialFixture ? "0" : "2");
    assert.equal(await popup.locator("#remaining").textContent(), partialFixture ? "—" : "0");
    if (partialFixture) {
      assert.equal(await popup.locator("#failed").textContent(), "0 / 1");
      await popup.getByRole("button", { name: "Start removing…", exact: true }).click();
      assert.equal(await popup.locator("#video-list li").count(), 1);
      assert.match(await popup.locator("#video-list").textContent(), /1000000000000000002/);
      assert.doesNotMatch(await popup.locator("#video-list").textContent(), /1000000000000000001/);
      assert.equal(posts, 1);
    }
    else assert.equal(await popup.locator("#percentage").textContent(), "100%");
    assert.deepEqual(errors, []);
    const result = { passed: true, partialFixture, browser: await browser.version(), mode: "Real Chrome isolated-world and popup integration; mocked Chrome extension APIs and TikTok network. No extension installed and no real TikTok requests.", checks: ["read-only scan", "real isolated world hidden from page", "hostile DOM events cannot remove", "extension popup review", "synthetic confirmation rejected", "trusted user click approves exact fixture IDs", "authenticated mock headers", "verification and counters", "no popup console errors", ...(partialFixture ? ["later malformed page preserves known candidates", "partial scan approval warning", "unknown total stays unknown", "partial verification never proves absence", "next batch excludes uncertain IDs and needs fresh approval"] : [])], requests, posts, errors };
    fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { if (releaseListing) releaseListing(); await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
