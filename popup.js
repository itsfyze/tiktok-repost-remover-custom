"use strict";
const $ = (id) => document.getElementById(id);
let current = null;
let busy = false;
let connected = false;
let renderedNonce = null;
let initializedSettings = false;
let connectionLost = false;
let actionRevision = 0;
function options() {
  return { delay: Number($("delay").value), limit: Number($("limit").value === "custom" ? $("custom").value : $("limit").value), keywords: $("keywords").value };
}
function error(message) { $("error").textContent = message || ""; $("error").hidden = !message; }
function render(result) {
  connected = !!result.connected;
  current = result.state || result.checkpoint || null;
  if (connected && current?.version !== "1.0.5") {
    connected = false;
    current = null;
    $("connection").textContent = "Refresh TikTok to finish the update";
    $("dot").classList.remove("on");
    controls();
    throw new Error("Extension updated to version 1.0.5. Refresh the connected TikTok tab, click Connect, and scan again before removing anything.");
  }
  $("connection").textContent = connected ? (current?.account ? "TikTok account identified" : "TikTok tab connected · scan to check account") : "Not connected";
  $("dot").classList.toggle("on", connected);
  if (!current) { controls(); return; }
  if (!initializedSettings && current.settings) {
    $("delay").value = current.settings.delay;
    const limit = String(current.settings.limit);
    $("limit").value = ["5", "10", "25", "50", "100"].includes(limit) ? limit : "custom";
    $("custom").value = limit;
    $("custom-wrap").hidden = $("limit").value !== "custom";
    $("keywords").value = current.settings.keywords;
    initializedSettings = true;
  }
  const discovered = Math.max(current.total || 0, current.scanned || 0);
  $("total").textContent = current.complete ? current.total : (discovered ? `${discovered}+` : "—");
  $("remaining").textContent = current.complete ? current.remaining : "—";
  $("removed").textContent = current.removed || 0;
  $("failed").textContent = `${current.failed || 0} / ${current.uncertain || 0}`;
  $("phase").textContent = String(current.phase || "idle").replaceAll("_", " ");
  $("status").textContent = connected ? current.message : "Saved history available. Connect and scan to reconcile before continuing.";
  const progress = current.batch || current.lastBatch;
  const percent = progress?.size ? Math.floor(100 * progress.completed / progress.size) : 0;
  $("progress").value = percent;
  $("percentage").textContent = percent + "%";
  const cooldown = Math.max(0, Math.ceil((current.cooldownUntil - Date.now()) / 1000));
  $("cooldown").hidden = !cooldown;
  $("cooldown").textContent = `Cooldown: ${Math.ceil(cooldown / 60)} minute(s) remaining. No automatic restart.`;
  const awaiting = connected && current.phase === "awaiting" && current.batch;
  $("approval").hidden = !awaiting;
  if (awaiting && renderedNonce !== current.batch.nonce) {
    renderedNonce = current.batch.nonce;
    $("ack").checked = false;
    $("approval-summary").textContent = `${current.batch.size} repost(s), ${current.settings.delay}s minimum between requests. Only the video IDs below are approved.`
      + (current.batch.partial ? " This scan is partial: your full repost total is unknown. Missing videos will not be marked removed unless a complete verification confirms it." : "");
    if (current.batch.progressive) $("approval-summary").textContent += " After this batch, discovery continues and any further batch will ask for a new confirmation.";
    $("video-list").replaceChildren();
    for (const id of current.batch.ids) {
      const item = current.items.find((entry) => entry.id === id);
      const li = document.createElement("li");
      li.textContent = item?.desc || "No description";
      const detail = document.createElement("span");
      detail.textContent = `@${item?.author || "unknown"} · Video ${id}`;
      li.append(detail); $("video-list").append(li);
    }
  }
  if (!awaiting) renderedNonce = null;
  controls();
}
function controls() {
  const phase = current?.phase || "idle";
  const active = ["scanning", "removing", "verifying", "paused"].includes(phase) || !!current?.progressive;
  $("connect").textContent = connectionLost ? "Reconnect" : "Connect";
  $("connect").disabled = busy || (connected && active);
  $("scan").disabled = busy || !connected || active || Date.now() < (current?.cooldownUntil || 0);
  const removeFound = !!current?.canRemoveFoundNow;
  $("prepare").disabled = busy || !connected || (!(current?.complete || current?.partial) && !removeFound) || (active && !removeFound) || !current?.actionable || phase === "awaiting";
  $("prepare").textContent = removeFound ? "Remove found so far…" : "Start removing…";
  $("scan-remove").disabled = busy || !connected || active || phase === "awaiting" || Date.now() < (current?.cooldownUntil || 0);
  $("pause").disabled = busy || !connected || !["scanning", "removing", "verifying"].includes(phase);
  $("resume").disabled = busy || !connected || phase !== "paused";
  $("stop").disabled = busy || ((!connected && !connectionLost) || (!active && phase !== "awaiting"));
  $("stop").textContent = connectionLost ? "Try to stop" : current?.canKeepScanResults ? (phase === "awaiting" ? "Cancel batch & keep results" : "Stop scan & keep results") : "Stop";
  $("approve").disabled = busy || !connected || phase !== "awaiting" || !$("ack").checked || Date.now() >= (current?.batch?.expires || 0);
  for (const id of ["delay", "limit", "custom", "keywords"]) $(id).disabled = active || phase === "awaiting" || busy;
}
async function send(type, extra = {}, silent = false) {
  const revision = silent ? actionRevision : ++actionRevision;
  if (!silent) { busy = true; error(""); controls(); }
  let timer;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type, ...extra }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("The extension did not reply within 30 seconds. The job may still be running; reconnect or try Stop. No action was retried."), { code: "CONNECTION" })), 30000); }),
    ]);
    if (silent && revision !== actionRevision) return;
    if (!result?.ok) throw Object.assign(new Error(result?.error || "Extension did not respond."), { code: result?.code || "CONNECTION" });
    render(result);
    if (connected && connectionLost) { connectionLost = false; error(""); controls(); }
  } catch (failure) {
    if (silent && revision !== actionRevision) return;
    error(failure.message);
    if (type === "state" || ["CONNECTION", "AGENT_MISSING", "AGENT_ERROR", "AGENT_PROTOCOL"].includes(failure.code) || !failure.code) {
      connected = false; connectionLost = true;
      $("connection").textContent = "Connection lost · last status shown";
      $("dot").classList.remove("on");
      $("phase").textContent = "connection lost";
      $("status").textContent = "Live progress is unavailable. The job may still be running. Reconnect to check the same job, or try Stop. Refreshing TikTok interrupts it; scan again to reconcile before another batch.";
      $("approval").hidden = true;
      controls();
    }
  } finally { clearTimeout(timer); if (!silent) { busy = false; controls(); } }
}
// These listeners exist in extension origin, never in TikTok's DOM. Page scripts
// cannot access this page or its internal runtime messaging channel.
function on(id, handler) { $(id).addEventListener("click", (event) => { if (event.isTrusted && !busy) handler(); }); }
on("connect", () => send("connect"));
on("scan", () => send("scan", { settings: options() }));
on("scan-remove", () => send("scanAndRemove", { settings: options() }));
on("prepare", () => send("prepare", { settings: options() }));
on("approve", () => { if ($("ack").checked && current?.batch) send("approve", { nonce: current.batch.nonce }); });
on("pause", () => send("pause"));
on("resume", () => send("resume"));
on("stop", () => send("stop"));
on("cancel-approval", () => send("stop"));
on("expand", async () => {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }); }
  catch { error("Could not open the dashboard tab. Reopen the extension popup and try again."); }
});
$("ack").addEventListener("change", controls);
$("limit").addEventListener("change", () => { $("custom-wrap").hidden = $("limit").value !== "custom"; });
send("state", {}, true);
let polling = false;
setInterval(async () => { if (busy || polling) return; polling = true; try { await send("state", {}, true); } finally { polling = false; } }, 1500);
