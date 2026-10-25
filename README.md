# Repost Reset — personal TikTok repost remover

New, local Manifest V3 implementation. No build, npm install, server, CDN, login form, telemetry, or subscription. The original reference repository is unchanged.

## Installation

Prepared destination: `C:\Users\dominic\Downloads\TikTokRepostRemoverCustom`.

1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `TikTokRepostRemoverCustom` folder itself, containing `manifest.json`.
5. Confirm the card reads **Repost Reset — Personal TikTok Remover**, version **1.0.0**, with no Errors button. If Errors appears, inspect it before connecting to your account.
6. In Details, check site access is only **https://www.tiktok.com/**. The declared API permissions are only `scripting` and `storage`. There is no `tabs`, cookies, history, downloads, or debugger permission.
7. Pin the extension if desired and open its popup. The ↗ button opens the same dashboard in a Chrome tab.

No extension has been installed into your normal profile during development. Its actual installed permissions and Chrome service-worker registration still require validation after loading. To uninstall, click Remove on its card; checkpoint/configuration storage is removed with the extension. To update this local source later, review changes first and click Reload on its card. Stop any job before updating.

## First use — read-only

1. You open TikTok in Chrome and navigate to **your own profile**. Sign in yourself if necessary. The extension does not sign you in or request your password.
2. Keep one intended TikTok profile tab active. Open the extension and click **Connect**. It attaches to the active TikTok tab (or an existing profile tab if none is active). Close other TikTok tabs if selection is ambiguous.
3. Click **Scan reposts · dry run**. This only lists reposts. No deletion listener or automatic job is installed in the page's MAIN world.
4. If account context, endpoint schema, session, or TikTok security checks are unavailable, the scan stops. Do not try to bypass challenges or security checks.
5. The scan must finish successfully before any removal batch can be prepared. Counts come from complete pagination. A failed or interrupted scan is not represented as a complete total.

## Removal — only after you explicitly authorize real actions

Development did not authorize or perform any real removals. Start with a batch limit of **5** only when you decide to test real removal. Default delay is 5 seconds; minimum 3 seconds is a conservative local bound, **not a TikTok-approved rate**.

- Adjust delay (3–120 seconds), next-batch limit (5/10/25/50/100 or custom 1–1000), and optional comma-separated description keywords. Matching is case-insensitive; any keyword matches. Empty filter selects all reposts.
- Click **Start removing…** to prepare a batch. This does not delete anything.
- Review the complete list of exact IDs and descriptions in the extension popup, check the acknowledgement, and click **Confirm removal**. Approval expires in five minutes. The only IDs allowed are those in that one approved batch.
- The extension removes sequentially with the configured delay, then lists again to verify disappearance. An accepted request is not counted as verified removed until verification succeeds. Remaining IDs or ambiguous operations are not silently counted as success.
- **Each further batch requires another review and confirmation**. There is no unlimited unattended approval. Thousands of reposts can be processed through successive approved batches of up to 1000.
- Pause prevents subsequent requests; a currently running request can finish. Resume only continues the same live paused job. Stop aborts all tracked active requests and cancels waiting work. **An action already accepted by TikTok cannot be reversed.**
- Closing the popup leaves an approved job running in the connected TikTok tab. Reopen it to monitor, pause or stop. Closing/reloading/navigating away from the TikTok tab interrupts the job; a browser request may already have reached TikTok.
- After interruption, click Connect and Scan again. Local checkpoints restore settings and outcome history, never an approval or a running deletion loop. Fresh scanning reconciles uncertain outcomes. If the account changed, previous account history is discarded from the active job.

## Rate limits, failures and API compatibility

HTTP 429 halts the job and records a cooldown honoring Retry-After, with a minimum 60 seconds and a conservative 1-hour fallback. An HTTP-date value is also understood. It never automatically restarts deletion after cooldown. Rescan and approve again. HTTP 401/403, nonzero TikTok status, malformed responses, timeouts and network/server failures also halt; no security checks are bypassed and no deletion is automatically retried.

TikTok's internal web endpoints are undocumented and may change or require website-specific signing. Current upstream source was inspected, but authenticated live listing and removal were **not tested**. In particular, moving fetches entirely into Chrome's isolated world avoids the insecure MAIN-world event bridge, but may not receive TikTok's page-world request instrumentation/signing. If TikTok rejects these requests, the extension stops; it does not fall back to remote code, security bypasses, credential extraction, or a page event bridge. A permitted real-account read-only scan is the next compatibility check.

The account and CSRF context must be present in TikTok's JSON hydration script. If a site version only exposes context in a page-global variable, this implementation stops with a clear error rather than introducing MAIN-world access.

## Data stored locally

Chrome local storage contains settings, the TikTok public account identifier used to bind history, per-video IDs/outcomes/timestamps, cooldown and status. It does **not** store credentials, cookies, CSRF tokens, pending approvals, or complete repost descriptions. TikTok's browser session supplies authentication; the CSRF token exists transiently in isolated memory and goes only to TikTok's removal endpoint. No sync storage or developer server is used.

Chrome session storage holds one connected tab ID, surviving worker suspension. A second job cannot be connected in another tab while this agent is reachable. No script is injected automatically into all TikTok pages. To switch the connected tab, stop first and close the old TikTok tab, then Connect again.

## Tests

Built-in Node tests, no install required:

```powershell
node --test .\tests\security.test.cjs
```

Optional real-Chrome integration using an existing Playwright installation:

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\path\to\existing\node_modules\playwright'
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:TEST_OUTPUT = 'C:\path\to\test-artifacts'
node .\tests\browser-smoke.cjs
```

The browser test creates a fresh, account-free browser context. It mocks TikTok network responses and Chrome extension APIs, while testing the actual popup in Chrome and the actual agent in a real isolated JavaScript world. It is not a loaded-extension test, a personal account test, or proof that live endpoints work. It records screenshots and sanitized fixture-only request paths. Do not adapt it to use a personal Chrome profile or authentication tokens.

Icons are original and generated using Node built-ins by `node .\tools\generate-icons.cjs`; already-generated PNGs are included. No compilation is required.

See `SECURITY.md` for the source review, request inventory, test coverage and limitations.
