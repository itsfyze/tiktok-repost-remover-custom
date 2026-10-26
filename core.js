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
  function successfulStatus(data) {
    if (!data || data.status_code !== 0) throw fault("TIKTOK", "TikTok rejected the operation or returned no recognized status. Job halted; inspect TikTok directly.");
    for (const value of [data, data.data]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const key of ["status_code", "statusCode"]) if (Object.hasOwn(value, key) && value[key] !== 0) throw fault("TIKTOK", "TikTok rejected the operation. Resolve any session or security notice before scanning again.");
    }
  }
  function listingParts(data) {
    const containers = [{ name: "root", value: data }];
    if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) containers.push({ name: "data", value: data.data });
    for (const { value } of containers) {
      for (const key of ["status_code", "statusCode"]) {
        if (Object.hasOwn(value, key) && value[key] !== 0) throw fault("TIKTOK", "TikTok rejected the listing. Open your profile directly and resolve any session or security notice before scanning again.");
      }
    }
    const found = [];
    const shape = [];
    for (const container of containers) {
      for (const key of ["itemList", "item_list"]) {
        const present = Object.hasOwn(container.value, key);
        const value = container.value[key];
        shape.push(`${container.name}.${key}: ${Array.isArray(value) ? "array" : present ? value === null ? "null" : typeof value : "missing"}`);
        if (present) found.push({ container, value });
      }
    }
    if (found.length !== 1 || !Array.isArray(found[0].value)) {
      throw fault("LIST_FORMAT", "TikTok returned no single supported repost list (" + shape.join(", ") + "). Wait before trying a read-only scan again. This does not confirm a rate limit; the Reposts tab is not required. No missing videos are assumed removed.", { missingList: found.length === 0 || (found.length === 1 && !Array.isArray(found[0].value)) });
    }
    const { container, value: items } = found[0];
    // Only these named containers/fields are accepted; never search arbitrary
    // response arrays or reinterpret a missing list as an empty complete list.
    const paging = container.value;
    const flags = [];
    for (const source of container.name === "root" ? [paging] : [paging, data]) {
      for (const key of ["hasMore", "has_more"]) if (Object.hasOwn(source, key)) flags.push(hasMoreFlag(source[key]));
    }
    const hasMore = !flags.length || flags.some((flag) => flag == null || flag !== flags[0]) ? null : flags[0];
    const cursor = paging.cursor ?? (container.name === "data" ? data.cursor : undefined);
    const conflictingCursor = container.name === "data" && paging.cursor != null && data.cursor != null && String(paging.cursor) !== String(data.cursor);
    return { items, hasMore, cursor, conflictingCursor };
  }
  function settings(input = {}) {
    const delay = Number(input.delay ?? 5);
    const limit = Number(input.limit ?? 5);
    if (!Number.isFinite(delay) || delay < 3 || delay > 120) throw fault("SETTINGS", "Delay must be 3–120 seconds.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fault("SETTINGS", "Batch limit must be a whole number from 1 to 1000.");
    return { delay, limit, keywords: String(input.keywords || "").trim().slice(0, 500) };
  }
  class Engine {
    constructor({ fetch, context, persist = async () => {}, uuid = () => crypto.randomUUID(), timeout = 20000, sleep, now = () => performance.now() } = {}) {
      this.fetch = fetch;
      this.context = context;
      this.persist = persist;
      this.uuid = uuid;
      this.timeout = timeout;
      this.now = now;
      this.lastRequestAt = null;
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
      this.progressive = false;
      this.approvalWaiter = null;
      this.scanFault = null;
      this.state = { phase: "idle", message: "Connect to your TikTok profile, then scan. No removals start automatically.", items: [], outcomes: {}, total: 0, scanned: 0, complete: false, partial: false, scanWarning: "", account: null, settings: settings(), batch: null, lastBatch: null, cooldownUntil: 0, updatedAt: Date.now() };
    }
    snapshot() {
      const state = clone(this.state);
      state.version = "1.0.5";
      const outcomes = Object.values(state.outcomes);
      state.removed = outcomes.filter((o) => o.status === "verified_removed").length;
      state.failed = outcomes.filter((o) => o.status === "failed").length;
      state.uncertain = outcomes.filter((o) => o.status === "uncertain").length;
      state.remaining = state.complete ? state.items.length : null;
      state.activeRequests = this.active.size;
      state.actionable = state.items.filter((item) => !["in_flight", "accepted", "uncertain"].includes(state.outcomes[item.id]?.status)).length;
      state.progressive = !!this.running && this.progressive;
      state.canKeepScanResults = !!this.running && this.isScanning() && !!state.items.length && !this.scanFault;
      state.canRemoveFoundNow = state.canKeepScanResults && !this.progressive && state.actionable > 0;
      return state;
    }
    isScanning() {
      return this.state.phase === "scanning" || (this.state.phase === "paused" && this.beforePause === "scanning") || (this.progressive && this.state.phase === "awaiting");
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
      this.state.outcomes = {};
      if (old.outcomes && typeof old.outcomes === "object" && !Array.isArray(old.outcomes)) {
        for (const [id, result] of Object.entries(old.outcomes)) {
          if (!validId(id) || !result || !["in_flight", "accepted", "uncertain", "failed", "verified_removed"].includes(result.status)) continue;
          this.state.outcomes[id] = { status: ["in_flight", "accepted"].includes(result.status) ? "uncertain" : result.status, at: Number.isFinite(result.at) ? result.at : 0 };
        }
      }
      this.state.account = typeof old.account === "string" && /^[A-Za-z0-9_-]{1,300}$/.test(old.account) ? old.account : null;
      if (!this.state.account) this.state.outcomes = {};
      try { this.state.settings = settings(old.settings); } catch { this.state.settings = settings(); }
      this.state.cooldownUntil = Number.isFinite(old.cooldownUntil) && old.cooldownUntil > 0 ? old.cooldownUntil : 0;
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
    checkCooldown() {
      if (Date.now() < this.state.cooldownUntil) throw fault("COOLDOWN", "TikTok cooldown is still active. Wait; no automatic retry or removal will occur.");
    }
    async request(path, params, method = "GET") {
      this.check();
      this.checkCooldown();
      if (!["/api/repost/item_list/", "/tiktok/v1/upvote/delete"].includes(path)) throw fault("DESTINATION", "Unapproved endpoint.");
      await this.runnable();
      const remainingDelay = this.lastRequestAt == null ? 0 : this.lastRequestAt + this.state.settings.delay * 1000 - this.now();
      if (remainingDelay > 0) { await this.wait(Math.ceil(remainingDelay)); await this.runnable(); }
      this.checkCooldown();
      let ctx;
      try { ctx = this.identity(); }
      catch (error) { if (method === "GET") this.scanFault = error.code || "LOGIN"; throw error; }
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
        const headers = { accept: "*/*" };
        const options = { method, headers, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal };
        if (method === "POST") {
          headers["content-type"] = "application/x-www-form-urlencoded";
          headers["tt-csrf-token"] = ctx.csrfToken;
          options.body = "";
        }
        this.lastRequestAt = this.now();
        const response = await this.fetch(ORIGIN + path + "?" + new URLSearchParams(params), options);
        if (response.status === 429) {
          const retry = response.headers?.get("retry-after");
          const seconds = /^\d+$/.test(retry || "") ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
          const wait = Math.max(60, Number.isFinite(seconds) ? seconds : 3600);
          throw fault("RATE_LIMIT", "TikTok rate-limited requests (HTTP 429). The job is halted; wait for the cooldown, rescan, and confirm a new batch.", { until: Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.min(wait, Number.MAX_SAFE_INTEGER / 1000) * 1000) });
        }
        if (response.status === 401 || response.status === 403) throw fault("SESSION", "TikTok rejected the session or security checks. Reload your profile. No bypass will be attempted.");
        if (!response.ok) throw fault("HTTP", "TikTok returned HTTP " + response.status + ". Rescan before retrying.");
        const raw = await response.text();
        this.check();
        if (controller.signal.aborted) throw fault("TIMEOUT", "Request timed out and was aborted. Its server-side outcome may be unknown.");
        if (raw.length > 8000000) throw fault("SCHEMA", "TikTok returned an unexpectedly large response. No success is assumed.");
        // The reference accepts an empty successful DELETE acknowledgement.
        // It remains unverified here until a fresh complete listing proves absence.
        if (method === "POST" && !raw.trim()) return { status_code: 0 };
        if (!raw) throw fault("SCHEMA", "TikTok returned an empty listing response. No success is assumed.");
        let data;
        try { data = JSON.parse(raw); } catch { throw fault("SCHEMA", "TikTok returned non-JSON data. The endpoint may have changed or a security challenge may be required."); }
        successfulStatus(data);
        return data;
      } catch (error) {
        if (error.until) this.state.cooldownUntil = Math.max(this.state.cooldownUntil, error.until);
        if (method === "GET" && (timedOut || (!this.life.signal.aborted && error.name !== "AbortError") || (typeof error.code === "string" && error.code !== "CANCELLED"))) {
          this.scanFault = timedOut ? "TIMEOUT" : (error.code || "NETWORK");
        }
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
    async collect(onPage) {
      let cursor = "0";
      const cursors = new Set();
      const items = new Map();
      try {
        for (let page = 0; page < 2000; page++) {
          await this.runnable();
          if (cursors.has(cursor)) throw fault("PAGINATION", "TikTok repeated a pagination cursor.");
          cursors.add(cursor);
          let listing;
          for (let attempt = 0; attempt < 2; attempt++) {
            const data = await this.request("/api/repost/item_list/", { aid: "1988", count: "30", coverFormat: "2", cursor, needPinnedItemIds: "true", post_item_list_request_type: "0", secUid: this.account });
            try { listing = listingParts(data); break; }
            catch (error) {
              // A transient blank successful first page gets ONE delayed read
              // retry at the same cursor. Never retry POSTs, auth errors or 429s.
              if (error.code !== "LIST_FORMAT" || !error.missingList || items.size || attempt > 0) throw error;
              this.state.message = `TikTok returned no video list. Retrying this read-only page once after ${this.state.settings.delay}s; no removal is authorized.`;
              await this.wait(this.state.settings.delay * 1000);
              await this.runnable();
            }
          }
          let invalidItems = 0;
          for (const item of listing.items) {
            if (!item || !validId(item.id)) { invalidItems++; continue; }
            items.set(item.id, { id: item.id, desc: String(item.desc || "").slice(0, 4000), author: String(item.author?.uniqueId || "").slice(0, 100) });
          }
          this.state.scanned = items.size;
          // Publish validated IDs immediately so a deliberate Stop can retain them.
          // Verification must not overwrite candidates while still incomplete.
          if (this.isScanning() && this.state.phase !== "awaiting") {
            this.state.items = [...items.values()];
            this.state.total = Math.max(this.state.total, items.size);
          }
          if (this.state.phase === "scanning") this.state.message = `Scanning page ${page + 1} · ${items.size} unique reposts`;
          if (invalidItems) throw fault("LIST_FORMAT", "TikTok returned video entries with missing or invalid identifiers. Those entries were excluded.");
          const hasMore = listing.hasMore;
          if (hasMore == null) throw fault("LIST_FORMAT", "TikTok returned an unrecognized pagination flag.");
          if (listing.conflictingCursor || (hasMore && (listing.cursor == null || !/^\d{1,40}$/.test(String(listing.cursor))))) throw fault("PAGINATION", "TikTok returned conflicting, missing or invalid pagination cursors.");
          const mutated = onPage ? await onPage([...items.values()]) : false;
          this.check();
          if (mutated) {
            // Deletions shift TikTok's cursor list. Restart pagination, retaining
            // deduplication and consumed authorizations, so no shifted page is skipped.
            cursor = "0";
            cursors.clear();
          } else {
            if (!hasMore) return { items: [...items.values()], complete: true, warning: "" };
            cursor = String(listing.cursor);
          }
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
      }).catch(() => { this.state.phase = "error"; this.state.message = "Local checkpoint failed. Rescan before continuing."; this.approval = null; this.state.complete = false; this.state.partial = false; }).finally(() => { this.running = null; this.progressive = false; this.approvalWaiter = null; });
    }
    scanAndRemove(input) { return this.scan(input, true); }
    scan(input, progressive = false) {
      if (this.running) throw fault("BUSY", "Stop the current operation before scanning again.");
      if (Date.now() < this.state.cooldownUntil) throw fault("COOLDOWN", "TikTok cooldown is still active. Wait before scanning again.");
      this.state.settings = settings(input);
      this.scanFault = null;
      this.progressive = progressive;
      // Revoke an older scan/approval before checking current account context.
      // A failed new scan must never leave an earlier batch authorized.
      this.state.complete = false;
      this.state.partial = false;
      this.state.scanWarning = "";
      this.state.items = [];
      this.state.total = 0;
      this.state.batch = null;
      this.approval = null;
      const ctx = this.context();
      this.account = null;
      this.identity();
      this.account = ctx.secUid;
      if (this.state.account && this.state.account !== this.account) this.state.outcomes = {};
      this.state.account = this.account;
      this.state.phase = "scanning";
      this.state.message = progressive ? "Scan & remove started. Each discovered batch waits for your review and confirmation before any deletion." : "Read-only scan started. No deletions are authorized.";
      this.state.lastBatch = null;
      this.state.scanned = 0;
      this.launch(async () => {
        const attempted = [];
        const listing = await this.collect(progressive ? async (knownItems) => {
          this.state.items = knownItems;
          let mutated = false;
          while (this.candidates(this.state.settings).length) {
            await this.runnable();
            this.makeBatch(this.state.settings);
            const accepted = await new Promise((resolve) => { this.approvalWaiter = resolve; });
            this.check();
            if (!accepted) throw fault("CANCELLED", "Batch cancelled.");
            const ids = await this.removeApprovedBatch();
            attempted.push(...ids);
            mutated = ids.length > 0 || mutated;
            await this.runnable();
            this.approval = null;
            this.state.lastBatch = { size: this.state.batch.size, completed: this.state.batch.completed };
            this.state.batch = null;
            this.state.phase = "scanning";
            this.state.message = "Approved batch sent. Continuing discovery; another batch requires a new confirmation.";
          }
          return mutated;
        } : undefined);
        if (attempted.length) {
          await this.runnable();
          this.state.phase = "verifying";
          this.state.message = "Discovery finished. Verifying the approved removals with a fresh listing…";
          await this.wait(this.state.settings.delay * 1000);
          await this.finishVerification(attempted);
          return;
        }
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
      return this.makeBatch(input);
    }
    async prepareFound(input) {
      if (this.running) {
        if (!this.snapshot().canRemoveFoundNow) throw fault("BUSY", "Only a read-only scan with valid discovered videos can switch to removal. Stop other work first.");
        await this.stop();
      }
      return this.prepare(input);
    }
    candidates(config) {
      const words = config.keywords.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      return this.state.items.filter((item) => !["in_flight", "accepted", "uncertain"].includes(this.state.outcomes[item.id]?.status))
        .filter((item) => !words.length || words.some((word) => item.desc.toLowerCase().includes(word))).slice(0, config.limit);
    }
    makeBatch(input) {
      this.checkCooldown();
      this.identity();
      const nextSettings = settings(input);
      const ids = this.candidates(nextSettings).map((item) => item.id);
      if (!ids.length) throw fault("EMPTY", "No eligible reposts match this filter. Uncertain removals require a fresh scan before retrying.");
      this.state.settings = nextSettings;
      const nonce = this.uuid();
      this.approval = { nonce, ids: new Set(ids), started: false, expires: Date.now() + 5 * 60 * 1000 };
      this.state.batch = { nonce, ids, completed: 0, size: ids.length, partial: !this.state.complete, progressive: this.progressive, expires: this.approval.expires };
      this.state.phase = "awaiting";
      this.state.message = `Review ${ids.length} exact video IDs. Approval applies to this batch only.`;
      return this.snapshot();
    }
    approve(nonce) {
      this.checkCooldown();
      if ((this.running && !(this.progressive && this.approvalWaiter)) || this.state.phase !== "awaiting" || !this.approval || this.approval.nonce !== nonce || this.approval.started || Date.now() >= this.approval.expires) throw fault("UNAUTHORIZED", "Approval is missing, expired, already used, or does not match this batch.");
      this.identity();
      this.approval.started = true;
      this.state.phase = "removing";
      this.state.message = "Removing your approved batch. You may pause or stop.";
      if (this.progressive && this.approvalWaiter) {
        const resolve = this.approvalWaiter;
        this.approvalWaiter = null;
        resolve(true);
        return this.snapshot();
      }
      this.launch(async () => {
        const batch = await this.removeApprovedBatch();
        await this.runnable();
        this.approval = null;
        this.state.phase = "verifying";
        this.state.message = "Verifying against a fresh complete repost listing…";
        await this.wait(this.state.settings.delay * 1000);
        await this.finishVerification(batch);
      });
      return this.snapshot();
    }
    async removeApprovedBatch() {
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
        return batch;
    }
    async finishVerification(batch) {
        const listing = await this.collect();
        const items = listing.items;
        this.check();
        const remaining = new Set(items.map((item) => item.id));
        this.state.total = Math.max(this.state.total, new Set([...this.state.items.map((item) => item.id), ...remaining]).size);
        for (const id of batch) this.state.outcomes[id] = {
          // Presence proves remaining; absence proves removal ONLY after full pagination.
          status: remaining.has(id) ? "failed" : listing.complete ? "verified_removed" : "uncertain", at: Date.now(),
        };
        for (const [id, result] of Object.entries(this.state.outcomes)) {
          if (["in_flight", "accepted", "uncertain"].includes(result.status)) result.status = remaining.has(id) ? "failed" : listing.complete ? "verified_removed" : "uncertain";
        }
        this.state.items = items;
        this.state.complete = listing.complete;
        this.state.partial = !listing.complete;
        this.state.scanWarning = listing.warning;
        this.state.phase = listing.complete ? "ready" : "partial";
        this.state.message = listing.complete
          ? "Batch verified. Another batch always requires a new review and confirmation."
          : "Verification was partial: missing videos remain uncertain, not verified removed. You may approve another batch of known videos, excluding uncertain attempts. " + listing.warning;
        if (this.state.batch) this.state.lastBatch = { size: this.state.batch.size, completed: this.state.batch.completed };
        this.state.batch = null;
        await this.save();
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
      const keepScanResults = this.isScanning() && this.state.items.length > 0;
      this.life.abort();
      for (const controller of this.active.values()) controller.abort();
      if (this.approvalWaiter) { this.approvalWaiter(false); this.approvalWaiter = null; }
      if (this.running) await this.running;
      this.approval = null;
      this.state.batch = null;
      this.state.phase = "stopped";
      this.state.complete = false;
      this.state.partial = false;
      this.state.message = "Stopped. Pending browser requests were aborted. Actions already accepted by TikTok cannot be reversed. Scan to reconcile before restarting.";
      if (keepScanResults && !this.scanFault) {
        this.state.partial = true;
        this.state.phase = "partial";
        this.state.total = this.state.items.length;
        this.state.scanWarning = "You stopped discovery before it finished. The full account total is unknown.";
        this.state.message = `Scan stopped · ${this.state.items.length} validated videos kept. You can review and approve a removal batch from these results. No removals start automatically.`;
      }
      await this.save();
      return this.snapshot();
    }
  }
  root.RepostCore = { Engine, settings, validId, fault };
  if (typeof module !== "undefined" && module.exports) module.exports = root.RepostCore;
})(globalThis);
