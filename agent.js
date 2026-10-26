/* Injected on explicit Connect only. No page events, page UI, or message listeners. */
(function () {
  "use strict";
  if (globalThis.RepostAgent) return;
  const context = () => {
    const node = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (!node?.textContent) return null;
    let data;
    try { data = JSON.parse(node.textContent); } catch { return null; }
    const app = data?.__DEFAULT_SCOPE__?.["webapp.app-context"];
    if (!app?.user?.secUid) return null;
    return { secUid: app.user.secUid, csrfToken: typeof app.csrfToken === "string" ? app.csrfToken : "" };
  };
  const engine = new RepostCore.Engine({
    fetch: (...args) => fetch(...args), context,
    // Preserve outcomes/settings, not thousands of descriptions or pending IDs.
    persist: async (state) => chrome.storage.local.set({ checkpoint: { schema: 1, state: { ...state, items: [] } } }),
  });
  const ready = chrome.storage.local.get("checkpoint").then((data) => engine.restore(data.checkpoint));
  // Accessible only to our extension's ISOLATED-world executeScript calls.
  globalThis.RepostAgent = Object.freeze({
    async command(command) {
      await ready;
      switch (command.type) {
        case "state": return engine.snapshot();
        case "scan": return engine.scan(command.settings);
        case "scanAndRemove": return engine.scanAndRemove(command.settings);
        case "prepare": return engine.prepareFound(command.settings);
        case "approve": return engine.approve(command.nonce);
        case "pause": return engine.pause();
        case "resume": return engine.resume();
        case "stop": return engine.stop();
        default: throw new Error("Unknown agent command.");
      }
    },
  });
})();
