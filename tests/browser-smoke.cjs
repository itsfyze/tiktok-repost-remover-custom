"use strict";
// Optional development-only browser integration. Uses an already installed
// Chrome and an already available Playwright; downloads nothing. No real login.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const moduleRoot = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(moduleRoot);
const root = path.resolve(__dirname, "..");
const output = path.resolve(process.env.TEST_OUTPUT || path.join(root, "../runtime-validation"));
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
  const requests = [], errors = [];
  let posts = 0;
  let remaining = [{ id: "1000000000000000001", desc: "A quiet morning in the city", author: { uniqueId: "fixture" } }, { id: "1000000000000000002", desc: "Travel notes", author: { uniqueId: "fixture" } }];
  const checkpointStore = {}, sessionStore = {};
  try {
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.protocol === "file:") return route.continue();
      requests.push({ host: url.hostname, path: url.pathname, method: request.method() });
      assert.equal(url.origin, "https://www.tiktok.com", "Unexpected network destination in isolated test");
      if (url.pathname === "/@fixture") return route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Mock TikTok — no account</title><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"user":{"secUid":"fixture-account"},"csrfToken":"fixture-only"}}}</script><h1>Mock account only</h1>' });
      if (url.pathname === "/api/repost/item_list/") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status_code: 0, itemList: remaining, hasMore: false, cursor: "0" }) });
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
        return [{ result: await evaluate(`(${input.func.toString()})(${JSON.stringify(input.args[0])})`) }];
      } },
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), { chrome, console, URL });
    const popup = await context.newPage();
    popup.on("pageerror", (e) => errors.push(e.message));
    await popup.exposeFunction("repostTestMessage", (command) => new Promise((resolve) => listener(command, { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }, resolve)));
    await popup.addInitScript(() => { window.chrome.runtime = { sendMessage: (command) => window.repostTestMessage(command), getURL: (file) => file }; window.chrome.tabs = { create: () => {} }; });
    await popup.goto("file:///" + path.join(root, "popup.html").replaceAll("\\", "/"));
    await popup.getByRole("button", { name: "Connect", exact: true }).click();
    await popup.getByRole("button", { name: "Scan reposts · dry run", exact: true }).click();
    await popup.waitForFunction(() => document.getElementById("phase").textContent === "ready");
    assert.equal(posts, 0);
    assert.equal(await tiktok.evaluate(() => typeof globalThis.RepostAgent), "undefined");
    await tiktok.evaluate(() => { window.dispatchEvent(new CustomEvent("trr-remove-repost", { detail: { itemId: "1000000000000000001" } })); window.postMessage({ type: "approve", nonce: "forged" }, "*"); });
    assert.equal(posts, 0);
    await popup.screenshot({ path: path.join(output, "dashboard.png"), fullPage: true });
    await popup.setViewportSize({ width: 420, height: 600 });
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await popup.screenshot({ path: path.join(output, "popup-narrow.png"), fullPage: true });
    await popup.setViewportSize({ width: 900, height: 1200 });
    await popup.getByRole("button", { name: "Start removing…", exact: true }).click();
    assert.equal(posts, 0);
    assert.equal(await popup.getByRole("button", { name: "Confirm removal", exact: true }).isDisabled(), true);
    await popup.locator("#ack").check();
    // Synthetic JS events cannot confirm even with checkbox selected.
    await popup.locator("#approve").evaluate((button) => button.click());
    assert.equal(posts, 0);
    await popup.screenshot({ path: path.join(output, "batch-review.png"), fullPage: true });
    await popup.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await popup.waitForFunction(() => document.getElementById("phase").textContent === "ready", { timeout: 20000 });
    assert.equal(posts, 2);
    assert.equal(await popup.locator("#removed").textContent(), "2");
    assert.equal(await popup.locator("#remaining").textContent(), "0");
    assert.equal(await popup.locator("#percentage").textContent(), "100%");
    assert.deepEqual(errors, []);
    const result = { passed: true, browser: await browser.version(), mode: "Real Chrome isolated-world and popup integration; mocked Chrome extension APIs and TikTok network. No extension installed and no real TikTok requests.", checks: ["read-only scan", "real isolated world hidden from page", "hostile DOM events cannot remove", "extension popup review", "synthetic confirmation rejected", "trusted user click approves exact fixture IDs", "authenticated mock headers", "verification and counters", "no popup console errors"], requests, posts, errors };
    fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
