"use strict";
const $ = (id) => document.getElementById(id);
let current = null;
let busy = false;
let connected = false;
let renderedNonce = null;
let initializedSettings = false;
function options() {
  return { delay: Number($("delay").value), limit: Number($("limit").value === "custom" ? $("custom").value : $("limit").value), keywords: $("keywords").value };
}
function error(message) { $("error").textContent = message || ""; $("error").hidden = !message; }
function render(result) {
  connected = !!result.connected;
  current = result.state || result.checkpoint || null;
  if (connected && current?.version !== "1.0.1") {
    connected = false;
    current = null;
    $("connection").textContent = "Refresh TikTok to finish the update";
    $("dot").classList.remove("on");
    controls();
    throw new Error("Extension updated to 1.0.1. Refresh the connected TikTok tab, click Connect, and scan again before removing anything.");
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
  $("total").textContent = current.complete ? current.total : (current.scanned ? `${current.scanned}+` : "—");
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
  const active = ["scanning", "removing", "verifying", "paused"].includes(phase);
  $("connect").disabled = busy || (connected && active);
  $("scan").disabled = busy || !connected || active || Date.now() < (current?.cooldownUntil || 0);
  $("prepare").disabled = busy || !connected || !(current?.complete || current?.partial) || active || !current?.actionable || phase === "awaiting";
  $("pause").disabled = busy || !connected || !["scanning", "removing", "verifying"].includes(phase);
  $("resume").disabled = busy || !connected || phase !== "paused";
  $("stop").disabled = busy || !connected || (!active && phase !== "awaiting");
  $("approve").disabled = busy || !connected || phase !== "awaiting" || !$("ack").checked || Date.now() > (current?.batch?.expires || 0);
  for (const id of ["delay", "limit", "custom", "keywords"]) $(id).disabled = active || phase === "awaiting" || busy;
}
async function send(type, extra = {}, silent = false) {
  if (!silent) { busy = true; error(""); controls(); }
  try {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || "Extension did not respond.");
    render(result);
  } catch (failure) {
    error(failure.message);
    if (type === "state") { connected = false; controls(); }
  } finally { if (!silent) { busy = false; controls(); } }
}
// These listeners exist in extension origin, never in TikTok's DOM. Page scripts
// cannot access this page or its internal runtime messaging channel.
function on(id, handler) { $(id).addEventListener("click", (event) => { if (event.isTrusted && !busy) handler(); }); }
on("connect", () => send("connect"));
on("scan", () => send("scan", { settings: options() }));
on("prepare", () => send("prepare", { settings: options() }));
on("approve", () => { if ($("ack").checked && current?.batch) send("approve", { nonce: current.batch.nonce }); });
on("pause", () => send("pause"));
on("resume", () => send("resume"));
on("stop", () => send("stop"));
on("cancel-approval", () => send("stop"));
on("expand", () => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }));
$("ack").addEventListener("change", controls);
$("limit").addEventListener("change", () => { $("custom-wrap").hidden = $("limit").value !== "custom"; });
send("state", {}, true);
let polling = false;
setInterval(async () => { if (busy || polling) return; polling = true; try { await send("state", {}, true); } finally { polling = false; } }, 1500);
