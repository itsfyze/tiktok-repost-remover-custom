/* Shared with dependency-free Node tests. In Chrome this lives ONLY in ISOLATED world. */
(function (root) {
  "use strict";
  if (root.RepostCore) return;
  const ORIGIN = "https://www.tiktok.com";
  const validId = (id) => typeof id === "string" && /^\d{1,25}$/.test(id);
  const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const hasMoreFlag = (value) => {
    if ([true, 1, "1", "true"].includes(value)) return true;
    if ([false, 0, "0", "false"].includes(value)) return false;
    return null;
  };
  function settings(input = {}) {
    const delay = Number(input.delay ?? 5);
    const limit = Number(input.limit ?? 5);
    if (!Number.isFinite(delay) || delay < 3 || delay > 120) throw fault("SETTINGS", "Delay must be 3–120 seconds.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fault("SETTINGS", "Batch limit must be a whole number from 1 to 1000.");
    return { delay, limit, keywords: String(input.keywords || "").trim().slice(0, 500) };
  }
  class Engine {
    constructor({ fetch, context, persist = async () => {}, uuid = () => crypto.randomUUID(), timeout = 20000, sleep } = {}) {
      this.fetch = fetch;
      this.context = context;
      this.persist = persist;
      this.uuid = uuid;
      this.timeout = timeout;
      this.sleep = sleep || ((ms, signal) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(fault("CANCELLED", "Cancelled."));
        const abort = () => { clearTimeout(timer); reject(fault("CANCELLED", "Cancelled.")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
        signal.addEventListener("abort", abort, { once: true });
      }));
      this.active = new Map();
      this.running = null;
      this.life = new AbortController();
      this.approval = null;
      this.account = null;
      this.persistTail = Promise.resolve();
      this.state = { phase: "idle", message: "Connect to your TikTok profile, then scan. No removals start automatically.", items: [], outcomes: {}, total: 0, scanned: 0, complete: false, partial: false, scanWarning: "", account: null, settings: settings(), batch: null, lastBatch: null, cooldownUntil: 0, updatedAt: Date.now() };
    }
    snapshot() {
      const state = clone(this.state);
      state.version = "1.0.1";
      const outcomes = Object.values(state.outcomes);
      state.removed = outcomes.filter((o) => o.status === "verified_removed").length;
      state.failed = outcomes.filter((o) => o.status === "failed").length;
      state.uncertain = outcomes.filter((o) => o.status === "uncertain").length;
      state.remaining = state.complete ? state.items.length : null;
      state.activeRequests = this.active.size;
      state.actionable = state.items.filter((item) => !["in_flight", "accepted", "uncertain"].includes(state.outcomes[item.id]?.status)).length;
      return state;
    }
    async save() {
      this.state.updatedAt = Date.now();
      // Whitelist persisted fields: never context/CSRF, controllers, or approval capability.
      const snapshot = {
        phase: this.state.phase, message: this.state.message,
        outcomes: clone(this.state.outcomes), settings: clone(this.state.settings),
        account: this.state.account, total: this.state.total, scanned: this.state.scanned,
        cooldownUntil: this.state.cooldownUntil, updatedAt: this.state.updatedAt,
        items: [], complete: false,
      };
      this.persistTail = this.persistTail.catch(() => {}).then(() => this.persist(snapshot));
      await this.persistTail;
    }
    restore(value) {
      if (!value || value.schema !== 1 || !value.state || !Array.isArray(value.state.items)) return;
      const old = value.state;
      this.state.outcomes = old.outcomes && typeof old.outcomes === "object" ? clone(old.outcomes) : {};
      for (const result of Object.values(this.state.outcomes)) {
        if (result.status === "in_flight") result.status = "uncertain";
      }
      this.state.account = typeof old.account === "string" ? old.account : null;
      this.state.settings = settings(old.settings);
      this.state.cooldownUntil = Number(old.cooldownUntil) || 0;
      this.state.phase = "interrupted";
      this.state.message = "Saved history found. Scan again to reconcile your account before approving a new batch.";
      // Never restore pending IDs as authority, an approval, a loop, or an authenticated context.
    }
    identity() {
      const ctx = this.context();
      if (!ctx || typeof ctx.secUid !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(ctx.secUid)) throw fault("LOGIN", "Could not identify the signed-in account. Open your own TikTok profile and reload it. No login is performed by this extension.");
      if (this.account && ctx.secUid !== this.account) throw fault("ACCOUNT_CHANGED", "The TikTok account changed. Stop and scan again.");
      return ctx;
    }
    check() {
      if (this.life.signal.aborted) throw fault("CANCELLED", "Stopped. A request already accepted by TikTok cannot be reversed.");
    }
    async request(path, params, method = "GET") {
      this.check();
      if (!["/api/repost/item_list/", "/tiktok/v1/upvote/delete"].includes(path)) throw fault("DESTINATION", "Unapproved endpoint.");
      const ctx = this.identity();
      if (method === "POST") {
        const id = params.item_id;
        if (!this.approval || !this.approval.started || !this.approval.ids.has(id) || !validId(id) || this.state.phase !== "removing") throw fault("UNAUTHORIZED", "Video is not authorized for this batch.");
        if (!ctx.csrfToken) throw fault("CSRF", "TikTok's request protection token is unavailable. Reload your profile; no security check will be bypassed.");
      } else if (method !== "GET" || path !== "/api/repost/item_list/") throw fault("UNAUTHORIZED", "Invalid request method.");
      if ((method === "POST") !== (path === "/tiktok/v1/upvote/delete")) throw fault("UNAUTHORIZED", "Invalid endpoint/method pair.");
      const id = this.uuid();
      const controller = new AbortController();
      const parentAbort = () => controller.abort();
      this.life.signal.addEventListener("abort", parentAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeout);
      this.active.set(id, controller);
      try {
        const headers = { accept: "application/json" };
        const options = { method, headers, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal };
        if (method === "POST") {
          headers["content-type"] = "application/x-www-form-urlencoded";
          headers["tt-csrf-token"] = ctx.csrfToken;
          options.body = "";
        }
        const response = await this.fetch(ORIGIN + path + "?" + new URLSearchParams(params), options);
        if (response.status === 429) {
          const retry = response.headers?.get("retry-after");
          const seconds = /^\d+$/.test(retry || "") ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
          const wait = Math.max(60, Number.isFinite(seconds) ? seconds : 3600);
          throw fault("RATE_LIMIT", "TikTok rate-limited requests. The job is halted; wait for the cooldown, rescan, and confirm a new batch.", { until: Date.now() + wait * 1000 });
        }
        if (response.status === 401 || response.status === 403) throw fault("SESSION", "TikTok rejected the session or security checks. Reload your profile. No bypass will be attempted.");
        if (!response.ok) throw fault("HTTP", "TikTok returned HTTP " + response.status + ". Rescan before retrying.");
        const raw = await response.text();
        this.check();
        if (controller.signal.aborted) throw fault("TIMEOUT", "Request timed out and was aborted. Its server-side outcome may be unknown.");
        if (!raw || raw.length > 8000000) throw fault("SCHEMA", "TikTok returned an empty or unexpectedly large response. No success is assumed.");
        let data;
        try { data = JSON.parse(raw); } catch { throw fault("SCHEMA", "TikTok returned non-JSON data. The endpoint may have changed or a security challenge may be required."); }
        if (!data || data.status_code !== 0) throw fault("TIKTOK", "TikTok rejected the operation (status " + String(data?.status_code ?? "missing").slice(0, 30) + "). Job halted; inspect TikTok directly.");
        return data;
      } catch (error) {
        if (this.life.signal.aborted) throw fault("CANCELLED", "Stopped. Requests already accepted by TikTok cannot be reversed.");
        if (timedOut) throw fault("TIMEOUT", "Request timed out and was aborted. Rescan to reconcile any uncertain removal.");
        if (error.code) throw error;
        throw fault("NETWORK", "Request failed or was blocked by TikTok. No automatic deletion retry will occur; rescan first.");
      } finally {
        clearTimeout(timer);
        this.life.signal.removeEventListener("abort", parentAbort);
        this.active.delete(id);
      }
    }
    async wait(ms) {
      await this.sleep(ms, this.life.signal);
      this.check();
    }
    async runnable() {
      while (this.state.phase === "paused") await this.wait(150);
      this.check();
    }
    async collect() {
      let cursor = "0";
      const cursors = new Set();
      const items = new Map();
      try {
        for (let page = 0; page < 2000; page++) {
          await this.runnable();
          if (cursors.has(cursor)) throw fault("PAGINATION", "TikTok repeated a pagination cursor.");
          cursors.add(cursor);
          const data = await this.request("/api/repost/item_list/", { aid: "1988", count: "30", coverFormat: "2", cursor, needPinnedItemIds: "true", post_item_list_request_type: "0", secUid: this.account });
          if (!Array.isArray(data.itemList)) throw fault("LIST_FORMAT", "TikTok returned a page without a recognized video list.");
          let invalidItems = 0;
          for (const item of data.itemList) {
            if (!item || !validId(item.id)) { invalidItems++; continue; }
            items.set(item.id, { id: item.id, desc: String(item.desc || "").slice(0, 4000), author: String(item.author?.uniqueId || "").slice(0, 100) });
          }
          this.state.scanned = items.size;
          if (this.state.phase !== "verifying") this.state.message = `Scanning page ${page + 1} · ${items.size} unique reposts`;
          if (invalidItems) throw fault("LIST_FORMAT", "TikTok returned video entries with missing or invalid identifiers. Those entries were excluded.");
          const hasMore = hasMoreFlag(data.hasMore);
          if (hasMore == null) throw fault("LIST_FORMAT", "TikTok returned an unrecognized pagination flag.");
          if (!hasMore) return { items: [...items.values()], complete: true, warning: "" };
          if (data.cursor == null || !/^\d{1,40}$/.test(String(data.cursor))) throw fault("PAGINATION", "TikTok returned a missing or invalid pagination cursor.");
          cursor = String(data.cursor);
          await this.wait(this.state.settings.delay * 1000);
        }
        throw fault("PAGINATION", "Scan page safety limit reached.");
      } catch (error) {
        this.check();
        // Only structurally invalid successful listings permit partial use.
        // Session/security, HTTP, rate-limit, transport, raw JSON and cancellation
        // errors still abort the job and revoke removal eligibility.
        if (!["LIST_FORMAT", "PAGINATION"].includes(error.code) || !items.size) throw error;
        return { items: [...items.values()], complete: false, warning: error.message };
      }
    }
    launch(task) {
      if (this.running) throw fault("BUSY", "Another operation is already running.");
      this.life = new AbortController();
      this.running = Promise.resolve().then(task).catch(async (error) => {
        for (const result of Object.values(this.state.outcomes)) {
          if (["accepted", "in_flight"].includes(result.status)) result.status = "uncertain";
        }
        this.approval = null;
        this.state.batch = null;
        this.state.phase = error.code === "CANCELLED" ? "stopped" : error.code === "RATE_LIMIT" ? "rate_limited" : "error";
        this.state.message = error.message;
        this.state.complete = false;
        this.state.partial = false;
        if (error.until) this.state.cooldownUntil = error.until;
        await this.save();
      }).catch(() => { this.state.phase = "error"; this.state.message = "Local checkpoint failed. Rescan before continuing."; this.approval = null; this.state.complete = false; this.state.partial = false; }).finally(() => { this.running = null; });
    }
    scan(input) {
      if (this.running) throw fault("BUSY", "Stop the current operation before scanning again.");
      if (Date.now() < this.state.cooldownUntil) throw fault("COOLDOWN", "TikTok cooldown is still active. Wait before scanning again.");
      this.state.settings = settings(input);
      // Revoke an older scan/approval before checking current account context.
      // A failed new scan must never leave an earlier batch authorized.
      this.state.complete = false;
      this.state.partial = false;
      this.state.scanWarning = "";
      this.state.items = [];
      this.state.batch = null;
      this.approval = null;
      const ctx = this.context();
      this.account = null;
      this.identity();
      this.account = ctx.secUid;
      if (this.state.account && this.state.account !== this.account) this.state.outcomes = {};
      this.state.account = this.account;
      this.state.phase = "scanning";
      this.state.message = "Read-only scan started. No deletions are authorized.";
      this.state.lastBatch = null;
      this.state.scanned = 0;
      this.launch(async () => {
        const listing = await this.collect();
        const items = listing.items;
        this.check();
        this.state.items = items;
        this.state.total = items.length;
        const remaining = new Set(items.map((item) => item.id));
        for (const [id, result] of Object.entries(this.state.outcomes)) {
          if (["in_flight", "uncertain", "accepted"].includes(result.status)) {
            if (remaining.has(id)) result.status = "failed";
            else result.status = listing.complete ? "verified_removed" : "uncertain";
          }
        }
        this.state.complete = listing.complete;
        this.state.partial = !listing.complete;
        this.state.scanWarning = listing.warning;
        this.state.phase = listing.complete ? "ready" : "partial";
        this.state.message = listing.complete
          ? `Scan complete · ${items.length} reposts currently listed. Review and approve a batch to remove any.`
          : `Partial scan · ${items.length} validated reposts retained; your full total is unknown. You can review and approve a batch from these results. ${listing.warning}`;
        await this.save();
      });
      return this.snapshot();
    }
    prepare(input) {
      if (this.running || !(this.state.complete || this.state.partial) || !["ready", "partial", "awaiting"].includes(this.state.phase)) throw fault("NOT_READY", "Scan for valid reposts first. Errors affecting authentication or security must be resolved before removal.");
      this.identity();
      const nextSettings = settings(input);
      const words = nextSettings.keywords.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      const ids = this.state.items.filter((item) => !["in_flight", "accepted", "uncertain"].includes(this.state.outcomes[item.id]?.status))
        .filter((item) => !words.length || words.some((word) => item.desc.toLowerCase().includes(word))).slice(0, nextSettings.limit).map((item) => item.id);
      if (!ids.length) throw fault("EMPTY", "No eligible reposts match this filter. Uncertain removals require a fresh scan before retrying.");
      this.state.settings = nextSettings;
      const nonce = this.uuid();
      this.approval = { nonce, ids: new Set(ids), started: false, expires: Date.now() + 5 * 60 * 1000 };
      this.state.batch = { nonce, ids, completed: 0, size: ids.length, partial: this.state.partial, expires: this.approval.expires };
      this.state.phase = "awaiting";
      this.state.message = `Review ${ids.length} exact video IDs. Approval applies to this batch only.`;
      return this.snapshot();
    }
    approve(nonce) {
      if (this.running || this.state.phase !== "awaiting" || !this.approval || this.approval.nonce !== nonce || this.approval.started || Date.now() > this.approval.expires) throw fault("UNAUTHORIZED", "Approval is missing, expired, already used, or does not match this batch.");
      this.identity();
      this.approval.started = true;
      this.state.phase = "removing";
      this.state.message = "Removing your approved batch. You may pause or stop.";
      this.launch(async () => {
        const batch = [...this.approval.ids];
        for (let index = 0; index < batch.length; index++) {
          await this.runnable();
          const id = batch[index];
          this.state.outcomes[id] = { status: "in_flight", at: Date.now() };
          await this.save(); // Durable intent before dispatch; a failed save prevents deletion.
          await this.runnable();
          try {
            await this.request("/tiktok/v1/upvote/delete", { aid: "1988", item_id: id }, "POST");
            this.state.outcomes[id] = { status: "accepted", at: Date.now() };
          } catch (error) {
            this.state.outcomes[id] = { status: ["TIMEOUT", "NETWORK", "CANCELLED", "HTTP", "SCHEMA"].includes(error.code) ? "uncertain" : "failed", at: Date.now(), code: error.code };
            throw error;
          }
          this.approval.ids.delete(id); // Consume authorization after a successful response.
          this.state.batch.completed = index + 1;
          this.state.message = `TikTok accepted ${index + 1} of ${batch.length} requests. Verification follows.`;
          await this.save();
          if (index + 1 < batch.length) await this.wait(this.state.settings.delay * 1000);
        }
        await this.runnable();
        this.approval = null;
        this.state.phase = "verifying";
        this.state.message = "Verifying against a fresh complete repost listing…";
        await this.wait(this.state.settings.delay * 1000);
        const listing = await this.collect();
        const items = listing.items;
        this.check();
        const remaining = new Set(items.map((item) => item.id));
        for (const id of batch) this.state.outcomes[id] = {
          // Presence proves remaining; absence proves removal ONLY after full pagination.
          status: remaining.has(id) ? "failed" : listing.complete ? "verified_removed" : "uncertain", at: Date.now(),
        };
        this.state.items = items;
        this.state.complete = listing.complete;
        this.state.partial = !listing.complete;
        this.state.scanWarning = listing.warning;
        this.state.phase = listing.complete ? "ready" : "partial";
        this.state.message = listing.complete
          ? "Batch verified. Another batch always requires a new review and confirmation."
          : "Verification was partial: missing videos remain uncertain, not verified removed. You may approve another batch of known videos, excluding uncertain attempts. " + listing.warning;
        this.state.lastBatch = { size: this.state.batch.size, completed: this.state.batch.completed };
        this.state.batch = null;
        await this.save();
      });
      return this.snapshot();
    }
    pause() {
      if (!this.running || !["scanning", "removing", "verifying"].includes(this.state.phase)) throw fault("STATE", "No running operation to pause.");
      this.beforePause = this.state.phase;
      this.state.phase = "paused";
      this.state.message = "Paused. An in-flight request may finish; no subsequent request starts until Resume.";
      return this.snapshot();
    }
    resume() {
      if (!this.running || this.state.phase !== "paused") throw fault("STATE", "Interrupted or stopped jobs need a fresh scan and approval.");
      this.state.phase = this.beforePause;
      this.state.message = "Resumed the current operation.";
      return this.snapshot();
    }
    async stop() {
      this.life.abort();
      for (const controller of this.active.values()) controller.abort();
      if (this.running) await this.running;
      this.approval = null;
      this.state.batch = null;
      this.state.phase = "stopped";
      this.state.complete = false;
      this.state.partial = false;
      this.state.message = "Stopped. Pending browser requests were aborted. Actions already accepted by TikTok cannot be reversed. Scan to reconcile before restarting.";
      await this.save();
      return this.snapshot();
    }
  }
  root.RepostCore = { Engine, settings, validId, fault };
  if (typeof module !== "undefined" && module.exports) module.exports = root.RepostCore;
})(globalThis);
