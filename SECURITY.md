# Security review — Repost Reset 1.0.0

Reviewed 2026-10-24. This is a new implementation, informed by the API behavior in `gabireze/tiktok-all-reposted-videos-remover` at `b37346888f82262f46a25417c1fc68398d6009a0`. The original audited source is unchanged. No precompiled extension was used.

## Decision and limits

Prepared for an unpacked installation review. No significant credential-exfiltration path or page-triggered removal channel was found in the generated production code. Authorization, cancellation, checkpoint and error-handling tests pass with synthetic data. This review does **not** establish that the live TikTok API accepts this implementation, that the browser will always complete a requested abort before the server acts, or that automating thousands of removals is acceptable under TikTok's current account policies.

No normal Chrome profile was modified. Installation, real-account read-only scanning, and real removal are separate steps. No sign-in, personal cookie/token access, or real repost removal occurred. No saved personal browser profile was used by tests.

## Source completeness

All generated production and development executable files were read in full and reviewed after creation. Source is plain readable JavaScript without bundling or minification. Production files:

- `manifest.json`: Manifest V3, two API permissions, one exact HTTPS host, local popup/worker/icons and strict extension CSP.
- `background.js`: `trustedUI` validates exact extension ID and popup URL, top-frame sender, and own dashboard tab when present; `invoke` runs the local isolated-world agent; `handle` allowlists commands and manages a session tab lease; runtime callback serializes commands and returns bounded errors. No fetch, credential access or page-origin message acceptance.
- `agent.js`: one-shot isolated initializer; `context` parses the fixed hydration JSON node and extracts only signed-in secUid and CSRF; local `Engine` wiring and storage checkpoint; `command` allowlists operations. No event or runtime-message listener, no page UI, no MAIN-world code. The agent's global object belongs to the isolated world and is invisible to page-world JavaScript.
- `core.js`: reviewed every Engine method (`constructor`, `snapshot`, `save`, `restore`, `identity`, `check`, `request`, `wait`, `runnable`, `collect`, `launch`, `scan`, `prepare`, `approve`, `pause`, `resume`, `stop`), helper (`validId`, `fault`, `clone`, `settings`) and timer/promise/filter/map callback. All network access is centralized in `request`.
- `popup.js`: reviewed helpers (`$`, `options`, `error`, `render`, `controls`, `send`, `on`), all control/checkbox/select listeners and polling callback. User-supplied descriptions and status use textContent; no HTML insertion. Removal confirmation uses a trusted click in extension origin and a matching in-memory batch capability.
- `popup.html`: local script/CSS/icon, dashboard, settings, controls and acknowledgement/review section; no forms posting externally or embedded remote content.
- `styles.css`: local presentation only; no external fonts, URL resources or imports. Reduced-motion preference supported.
- `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`: original deterministic PNG assets, not executable.

Development-only files, not registered as extension entry points:

- `tests/security.test.cjs`: Node test runner, assert/fs/path/vm, local source and fake data. All 34 tests and nested stubs/callbacks reviewed. VM evaluates own background source to model a worker, not remotely supplied JavaScript.
- `tests/browser-smoke.cjs`: uses already installed Playwright and Chrome in a fresh, account-free browser context. Its DevTools calls evaluate this project's local source in a real isolated world. Chrome extension APIs and TikTok responses are mocked. All fixture TikTok traffic is fulfilled by interception, never sent to TikTok. The test does not install an extension or operate a normal browser profile. An ordinary dummy page sends hostile events; it is unrelated to personal accounts.
- `tools/generate-icons.cjs`: uses built-in fs/path/zlib to draw pixels and encode four PNGs (CRC/chunk helpers). Writes only its local icons directory. No network or subprocess.
- `README.md`, `SECURITY.md`, `THIRD-PARTY-NOTICE.md`: documentation.

No package.json, lockfile, production library, build step, dependency installation or remote updater is needed. The optional browser test uses existing development tooling and does not add a production dependency.

## Authorization and trust boundaries

1. Chrome owns the extension popup origin. TikTok cannot embed it (CSP frame-ancestors none; no web-accessible resources), manipulate its DOM, read its approval nonce or send accepted messages as it.
2. UI action handlers require `event.isTrusted`; a DOM-generated click is rejected. The approval also requires the acknowledgement checkbox. This is defense against synthetic clicks, not a claim of protection from OS-level malware or a compromised Chrome process.
3. The worker accepts messages only from its exact popup page, including the same dashboard opened in an extension tab. TikTok content senders, other extensions and subframes are rejected. No externally_connectable entry is declared.
4. Connect injects local core/agent files only in ISOLATED world in frame 0 of the selected TikTok tab. There is no page DOM-event bridge, postMessage bridge, or persistent page-world deletion listener.
5. A completed full scan is required. Prepare filters scanned items, selects at most the explicit batch limit and records the exact numeric IDs with a crypto.randomUUID capability. Five-minute expiry applies before approval. No deletion occurs during scanning or preparation.
6. Approve checks the capability, unused status, expiry, account identity, no active loop and the waiting phase. Each POST checks the current account, job state and membership in the allowed ID set again. Successful request authorization is consumed. Repeated Start/Approve cannot create concurrent loops.
7. One service-worker command queue and one tab lease in chrome.storage.session prevent separate tab jobs while the selected agent remains reachable. The agent loop lives in the TikTok tab, not a service-worker global, so worker suspension does not restart or duplicate it.
8. Every further batch requires fresh review and approval. An interruption restores no approval or automatic deletion loop. Rescan reconciles history against the current account and current repost listing.

Threat-model limit: scripts already controlling the TikTok page can change its hydration DOM or interfere with the site itself. Chrome renderer compromise, malicious installed extensions, operating-system malware, a malicious TikTok server and a modified local extension folder are outside the protection offered here. The design does not treat page events as authority and does not grant the page a new extension command channel.

## Cancellation and failures

Each fetch receives a new UUID, a separate AbortController and a 20-second timeout covering response headers and body consumption. Controllers are registered in a Map, linked to the job AbortSignal and removed only in finally. Timeout calls abort. Stop aborts the job and **all** tracked controllers, waits for the loop to settle, revokes approval, and disables restart until a scan. Waiting delays are abortable. Checks immediately before dispatch prevent a Stop during a checkpoint write from starting the saved intent.

No POST is automatically retried. Timeouts and transport errors have ambiguous server outcomes; they are marked uncertain and reconciled via read-only listing. This avoids overlapping attempts entirely. Accepted operations become uncertain if verification cannot finish. Only successful complete verification of disappearance increments the verified removal counter. Server-side removal accepted before an abort may still happen and cannot be undone.

Pause blocks subsequent requests and leaves a currently running request alone; the UI says so. Resume is allowed only for a currently live paused loop. A stopped/interrupted job cannot use Resume to recover old authority. On restart, history's in-flight state becomes uncertain and a fresh scan is mandatory.

HTTP 429 stops the job and persists a cooldown: Retry-After seconds/date respected, minimum 60 seconds, fallback one hour if no valid header. There is no automatic deletion restart. HTTP 401/403, nonzero status_code, unexpected schema, HTTP errors and network errors stop. No CAPTCHA, authentication, signature or rate-limit check is bypassed. Delays are configurable 3–120 seconds and do not establish compliance with a published TikTok request budget.

## Authentication and persisted data

- Source: only JSON under `__UNIVERSAL_DATA_FOR_REHYDRATION__`, `webapp.app-context.user.secUid` and `csrfToken`.
- secUid: public account identifier; used in listing query and local account-bound checkpoint. No developer receives it.
- CSRF: read transiently immediately before requests, attached only to the fixed TikTok POST header. Not copied into engine state, UI snapshots, errors, tests output or local/session storage.
- Authentication cookies: the browser supplies eligible cookies using credentials same-origin. No cookie API, document.cookie read, cookie export, password input, password access, bearer-token extraction, localStorage or sessionStorage access exists.
- Chrome local checkpoint: options, account identifier, IDs/outcomes/timestamps, scan counts, status and cooldown. Full descriptions, approval nonce/set and credentials are excluded. Persistence writes are serialized; failure to save intent stops before dispatch. State may contain personally revealing keyword choices and viewing IDs, so this local data is not public.
- Chrome session storage: the connected tab ID only. It survives worker suspension, not a browser restart.
- In-memory scan data: item ID, bounded description and author handle. Displayed as text in the extension UI. No upload or export path.

## Complete request and permission inventory

All production HTTP requests use `https://www.tiktok.com`, `mode: same-origin`, `credentials: same-origin`, `redirect: error`, `cache: no-store`. Cross-origin fetches and redirects are blocked. Two fixed endpoint paths only:

| Endpoint | Method / explicit headers / body | Parameters and purpose |
|---|---|---|
| `/api/repost/item_list/` | GET; accept application/json; no body | aid=1988, count=30, coverFormat=2, cursor, needPinnedItemIds=true, post_item_list_request_type=0, secUid. Full scan and post-batch verification. |
| `/tiktok/v1/upvote/delete` | POST; accept application/json; content-type application/x-www-form-urlencoded; tt-csrf-token; empty body | aid=1988, item_id from exact approved ID set. Remove one authorized repost. |

Browser-added cookies/headers are not inspected or logged. Error text never includes response bodies or the token. chrome.runtime.sendMessage only carries UI commands/settings, batch nonce, and snapshots to the own worker. scripting.executeScript invokes local functions/files in the isolated world. No chrome.tabs.sendMessage, XHR, beacon, WebSocket, external image, telemetry, hidden redirect, external donation or remote script path exists. Expand opens only the own local dashboard page.

| Permission / policy | Justification |
|---|---|
| scripting | Inject local isolated core/agent and invoke their command method in the selected TikTok tab. |
| storage | Local checkpoint/history/settings; session connected-tab lease. |
| https://www.tiktok.com/* | Exact HTTPS hostname needed for isolated script and same-origin requests. No wildcard subdomain or unrelated host. |
| extension CSP | default/script/style/img self; connect none; object none; base-uri none; frame-ancestors none. UI/worker do not fetch externally; TikTok content fetch runs in its page-origin isolated world. |

No tabs permission: querying URLs for matching TikTok tabs is covered by host permission; creating the local dashboard tab needs no tabs permission. No cookies, history, debugger, webRequest, downloads, clipboard, nativeMessaging, management, unlimitedStorage or optional permission.

## Tests and outcomes

34 automated Node tests pass. They cover settings bounds; GET-only scan; missing authorization; destination/method rejection; approval nonce/ID binding; consumed/repeated/expired approvals; per-batch confirmation; keywords; account changes; missing account/CSRF; active scan/POST abort; timeout with no retry; unique IDs; Retry-After seconds/date/default; 401/403/500 and TikTok rejection; invalid/empty/oversized responses; strict listing schema; numeric IDs; repeated/missing cursor; multi-page deduplication/empty intermediate page; repeated Scan/Start; pause/resume; credential/approval-free checkpoints; restore/reconciliation; storage failure; verification failure/remaining repost; Stop during intent persistence; body timeout; account-switch history isolation; atomic preparation settings; worker command serialization and lease across simulated worker restart; sender rejection; permission and production-source checks.

Real Chrome 155.0.8059.85 integration passes with mocked Chrome APIs/TikTok responses. Verified actual isolated-world separation from main page, hostile DOM events and postMessage cannot remove, popup scan sends no POST, review required, synthetic confirm click rejected, trusted click processes exact fixture IDs, strict synthetic CSRF header, final verification/counters/progress, and no popup page errors. Screenshots were visually reviewed. Narrow popup layout is also checked for horizontal overflow. Artifacts: workspace `runtime-validation/`.

All generated JS/CJS files receive Node syntax checks. Manifest JSON and icon references are validated. A native installed Windows Defender custom scan is recorded in `VALIDATION.txt`; antivirus alone does not assess authorization. No third-party scanner or package installation was introduced.

Not covered by mocks: actual Chrome extension registration, installed permission prompt, actual browser storage quota behavior, operating-system suspension behavior, signed-in TikTok hydration availability, request signing, live API schemas, server-side deletion results, account enforcement or a safe sustained request budget.

## Current API investigation

The reference's current public main source was inspected via the web on the audit date. It still names the same listing and deletion paths and hydration fields. This is evidence of upstream implementation intent, **not** live API validation:

- [Current upstream listing source](https://raw.githubusercontent.com/gabireze/tiktok-all-reposted-videos-remover/main/script.js)
- [Current upstream deletion source](https://raw.githubusercontent.com/gabireze/tiktok-all-reposted-videos-remover/main/background.js)

The new implementation deliberately does not use the upstream MAIN-world fetch/event listener. TikTok may rely on page instrumentation for request signing; isolated fetch may be rejected. It stops rather than bypassing such checks. This compatibility limitation must be resolved by an explicitly permitted real-account read-only scan and then a separately approved small removal test; successful mocked tests do not resolve it.

Chrome documentation consulted: [content-script origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [service-worker lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Tabs API permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs).

## Remaining risk and next step

Account-theft behavior: none identified in reviewed source or fixture tests; no absolute safety claim. Implementation risks addressed: unauthorized page event commands removed, consent isolated, batch IDs bounded, timeout and Stop abort tracked requests, no overlapping deletion retries, no automatic recovery deletion. Remaining account-action risk is material because approved removal is destructive and TikTok controls its undocumented interface.

Before real use: load unpacked after the user's installation approval, verify Chrome reports no extension errors and matches this manifest, perform a user-approved read-only live scan, then ask for explicit authorization for a five-item real removal test. Do not begin thousands of removals based solely on this report. Every subsequent batch still requires a fresh user confirmation in the extension UI.
