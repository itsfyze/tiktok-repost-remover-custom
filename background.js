"use strict";
// Serializes UI commands even across overlapping popup messages. A durable tab
// lease survives worker suspension. No page/content-script message is accepted.
let commandTail = Promise.resolve();
function trustedUI(sender) {
  // sender.url identifies the document Chrome says sent the message. tab.url is
  // optional metadata and is not required for our dashboard opened in a tab.
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html") &&
    (sender.frameId == null || sender.frameId === 0);
}
async function invoke(tabId, command) {
  // Only status reads may be repeated. Never resend a possibly applied action.
  for (let attempt = 0; attempt < 2; attempt++) {
  let results;
  try {
  results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: "ISOLATED",
    func: async (input) => {
      const channel = "repost-reset-reply";
      if (!globalThis.RepostAgent) return { channel, ok: false, code: "AGENT_MISSING", error: "TikTok tab was reloaded. Reconnect and scan before removing." };
      try {
        // Catch inside the injected function: an execution exception can otherwise
        // become an undefined result rather than a rejected executeScript call.
        const value = await globalThis.RepostAgent.command(input);
        if (!value || typeof value !== "object") return { channel, ok: false, code: "AGENT_PROTOCOL", error: "TikTok agent returned an invalid status. Refresh TikTok and scan again." };
        // The dashboard only needs descriptions for the exact batch under review.
        // Do not transfer thousands of videos and full outcome history every poll.
        const { outcomes, items, ...state } = value;
        const approved = new Set(state.batch?.ids || []);
        state.items = Array.isArray(items) ? items.filter((item) => approved.has(item.id)) : [];
        return { channel, ok: true, state };
      } catch (error) {
        const known = typeof error?.code === "string";
        return { channel, ok: false, code: known ? error.code.slice(0, 40) : "AGENT_ERROR", error: known ? String(error.message).slice(0, 600) : "The TikTok agent could not read or update its job. Refresh TikTok and scan to reconcile before trying another batch." };
      }
    }, args: [command],
  });
  } catch {
    if (command.type === "state" && attempt === 0) continue;
    throw Object.assign(new Error("Lost contact with the TikTok tab. The previous job may still be running. Reconnect to check it, or try Stop. No removal command was retried."), { code: "CONNECTION" });
  }
  const response = results?.[0]?.result;
  if (response?.channel === "repost-reset-reply") {
    if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code });
    if (response.state && typeof response.state === "object") return response.state;
  }
  if (command.type === "state" && attempt === 0) continue;
  throw Object.assign(new Error("TikTok did not return a valid job status. The job may still be running. Reconnect to check it, or try Stop. No removal command was retried."), { code: "CONNECTION" });
  }
}
async function handle(command) {
  const allowed = new Set(["connect", "state", "scan", "scanAndRemove", "prepare", "approve", "pause", "resume", "stop"]);
  if (!command || !allowed.has(command.type)) throw new Error("Unknown command.");
  const stored = await chrome.storage.session.get("jobTab");
  let tabId = stored.jobTab;
  if (command.type === "connect") {
    let tab;
    if (Number.isInteger(tabId)) {
      try { return { state: await invoke(tabId, { type: "state" }), connected: true }; }
      catch (error) {
        if (error.code === "AGENT_MISSING") tab = { id: tabId };
        else if (error.code === "CONNECTION") {
          const existing = await chrome.tabs.query({ url: "https://www.tiktok.com/*" });
          // A transient failure is not evidence that an existing job disappeared.
          if (existing.some((item) => item.id === tabId)) throw error;
        } else throw error;
      }
    }
    if (!tab) {
      const tabs = await chrome.tabs.query({ url: "https://www.tiktok.com/*" });
      tab = tabs.find((item) => item.active) || tabs.find((item) => /\/@|\/profile/.test(item.url || ""));
    }
    if (!tab) throw new Error("Open your own profile at https://www.tiktok.com in Chrome, then Connect. This extension never signs you in.");
    tabId = tab.id;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", files: ["core.js", "agent.js"] });
    await chrome.storage.session.set({ jobTab: tabId });
  }
  if (!Number.isInteger(tabId)) return { connected: false, checkpoint: (await chrome.storage.local.get("checkpoint")).checkpoint?.state || null };
  try {
    return { state: await invoke(tabId, command.type === "connect" ? { type: "state" } : command), connected: true };
  } catch (error) {
    // Do not release the lease on a transient command error: this prevents a
    // second job on another tab while an existing agent may still be active.
    throw Object.assign(new Error(String(error.message || "Command failed").slice(0, 600)), { code: error.code });
  }
}
chrome.runtime.onMessage.addListener((command, sender, reply) => {
  if (!trustedUI(sender)) { reply({ ok: false, error: "Untrusted command source." }); return false; }
  commandTail = commandTail.catch(() => {}).then(() => handle(command));
  commandTail.then((result) => reply({ ok: true, ...result }), (error) => reply({ ok: false, error: error.message, code: typeof error.code === "string" ? error.code : "COMMAND" }));
  return true;
});
