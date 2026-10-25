"use strict";
// Serializes UI commands even across overlapping popup messages. A durable tab
// lease survives worker suspension. No page/content-script message is accepted.
let commandTail = Promise.resolve();
function trustedUI(sender) {
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html") &&
    (sender.frameId == null || sender.frameId === 0) &&
    (!sender.tab || sender.tab.url === chrome.runtime.getURL("popup.html"));
}
async function invoke(tabId, command) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: "ISOLATED",
    func: async (input) => {
      if (!globalThis.RepostAgent) throw new Error("TikTok tab was reloaded. Reconnect and scan before removing.");
      return globalThis.RepostAgent.command(input);
    }, args: [command],
  });
  if (!results?.[0]?.result) throw new Error("No response from TikTok tab. Reconnect and scan.");
  return results[0].result;
}
async function handle(command) {
  const allowed = new Set(["connect", "state", "scan", "prepare", "approve", "pause", "resume", "stop"]);
  if (!command || !allowed.has(command.type)) throw new Error("Unknown command.");
  const stored = await chrome.storage.session.get("jobTab");
  let tabId = stored.jobTab;
  if (command.type === "connect") {
    if (Number.isInteger(tabId)) {
      try { return { state: await invoke(tabId, { type: "state" }), connected: true }; } catch { /* Navigated/closed: old isolated job no longer exists. */ }
    }
    const tabs = await chrome.tabs.query({ url: "https://www.tiktok.com/*" });
    const tab = tabs.find((item) => item.active) || tabs.find((item) => /\/@|\/profile/.test(item.url || ""));
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
    throw new Error(String(error.message || "Command failed").slice(0, 600));
  }
}
chrome.runtime.onMessage.addListener((command, sender, reply) => {
  if (!trustedUI(sender)) { reply({ ok: false, error: "Untrusted command source." }); return false; }
  commandTail = commandTail.catch(() => {}).then(() => handle(command));
  commandTail.then((result) => reply({ ok: true, ...result }), (error) => reply({ ok: false, error: error.message }));
  return true;
});
