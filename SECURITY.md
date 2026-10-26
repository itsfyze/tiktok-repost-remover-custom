# Security review — Repost Reset 1.0.5

Reviewed 2026-10-26. Scope: every production/development executable source file in this project, manifest/UI/styles, local persistence, network destinations, authorization and controlled runtime tests. Reference comparison is pinned in UPSTREAM_REFERENCE.md. This is a separate source implementation; no precompiled extension was installed.

## Verdict and limits

“Safe” below means no corresponding malicious path was found in the reviewed source and controlled tests, not an absolute guarantee. No personal profile, real authentication values or live repost action was used.

| Category | Result | Evidence |
|---|---|---|
| Credential theft | Safe within review scope | No password form, cookie read/export, credential harvesting, keylogging, clipboard access or external credential destination. |
| Session token handling | Safe within review scope | Browser supplies eligible same-origin cookies. Only account secUid and CSRF are extracted from fixed hydration JSON; CSRF is transient and goes only to the fixed TikTok removal header. |
| External connections | Safe within review scope | Only www.tiktok.com production HTTP host; fixed endpoint allowlist, same-origin mode/credentials, redirect error. No telemetry, CDN, socket, beacon or remote script. |
| Malicious code | Safe within review scope | Plain local source; no obfuscation, dynamic code loading/eval, persistence outside normal extension storage, mining or unexpected downloads. |
| Browser permissions | Safe within review scope | scripting, storage and one exact HTTPS host; no tabs/cookies/history/debugger/downloads/clipboard/nativeMessaging permission. |
| Dependency security | Safe for production dependency surface | No production dependencies, package manager, bundler or build installation. Optional existing Playwright is development-only and not bundled. |
| Overall risk | Medium | Approved account changes are destructive; TikTok's private API, signing, enforcement and actual live success remain unverified. |

No account-theft behavior was identified. This does not establish that every bug is absent or that the live account can safely sustain thousands of operations.

## Reviewed files and functions

- manifest.json: local MV3 worker/popup/icons, strict self-only extension CSP and exact host permissions.
- background.js: trustedUI, invoke, handle, runtime listener and callbacks. Exact own-extension sender ID/page URL and top frame; command queue and one session tab lease; isolated frame-zero invocation. Tagged command results/errors, compact snapshots, status-only retry. A transient connection error cannot create another tab job.
- agent.js: initializer, context, Engine wiring/persist/restore promise and command dispatcher. Reads only the fixed hydration JSON node. No MAIN-world or page-event/runtime-message listener is installed in the TikTok page.
- core.js helpers: validId, fault, clone, hasMoreFlag, successfulStatus, listingParts and settings. Engine methods: constructor, snapshot, isScanning, save, restore, identity, check, checkCooldown, request, wait, runnable, collect, launch, scanAndRemove, scan, prepare, prepareFound, candidates, makeBatch, approve, removeApprovedBatch, finishVerification, pause, resume, stop; all timer/promise/filter/map callbacks.
- popup.js: options/error/render/controls/send/on, every control listener, dashboard opening and polling. Trusted clicks, explicit acknowledgement, exact batch nonce, bounded command timeout and stale-poll rejection. Untrusted descriptions/errors render as textContent, never HTML.
- popup.html/styles.css: local presentation, controls/review, no remote fonts, image loads, forms posting externally or CSS imports.
- tools/generate-icons.cjs: built-in fs/path/zlib and CRC/chunk logic generating four original local PNGs. No network/subprocess.
- tests/security.test.cjs, streaming.test.cjs, connection.test.cjs, listing-format.test.cjs, review.test.cjs and browser-smoke.cjs: all fixtures, callbacks, VM/CDP use and file access reviewed. VM/CDP evaluate only this project's local source for tests. No normal profile or live TikTok data is used.
- All documentation, checksums and test-result artifacts were checked for current-version consistency and credential inclusion. Legacy fix notes are marked historical.

## Complete request and data-flow inventory

| Destination | Method | Explicit headers/body | Data and reason |
|---|---|---|---|
| https://www.tiktok.com/api/repost/item_list/ | GET | accept */*; no body | aid=1988, count=30, coverFormat=2, exact cursor, needPinnedItemIds=true, post_item_list_request_type=0, secUid. Discovery and fresh verification. |
| https://www.tiktok.com/tiktok/v1/upvote/delete | POST | accept */*, content-type application/x-www-form-urlencoded, tt-csrf-token; empty body | aid=1988 and one numeric item_id from the exact approved set. Remove that repost. |

Both use credentials/mode same-origin, redirect error and cache no-store. Eligible authentication cookies are browser-added, not read, exported or logged. CSRF goes only in the POST header, never URL, UI, errors or checkpoints. secUid is a public account identifier used for query/account binding and local history.

chrome.runtime.sendMessage carries internal UI commands/settings, approval nonce and snapshots to the own worker, not to an external domain. chrome.scripting.executeScript invokes local code in the selected isolated world. There is no chrome.tabs.sendMessage, XMLHttpRequest, WebSocket, sendBeacon, remote image beacon, hidden redirect or external upload. The arrow opens only the own extension dashboard.

## Authorization and cancellation

Website scripts, other extensions, local file HTML and subframes cannot supply an accepted sender identity. Optional tab URL metadata is not used as document authority. No externally_connectable or web_accessible_resources is declared.

Each batch has exact numeric IDs, a random capability, five-minute pre-use expiry, acknowledgement and a trusted extension-origin click. Progressive mode waits for a new approval at every batch. POST checks the current account context, active phase and unconsumed ID again. No approval or loop is restored after interruption.

Each HTTP request has a unique controller/ID and a 20-second timeout for headers/body. Stop aborts the parent and every active request, resolves pending progressive approval waits, drains the loop and revokes authority. Pause blocks subsequent dispatch. Durable intent is stored before dispatch; storage failure prevents deletion. Stop during that write or a spacing delay cannot dispatch the pending POST.

A monotonic clock enforces configured minimum dispatch spacing across scan/removal/batch boundaries. HTTP 429 cooldown is independently enforced by preparation, approval and request dispatch. Retry-After is bounded to a finite stored timestamp. No POST is automatically retried; a missing acknowledgement can conceal an applied action.

Successful empty POST bodies, supported by the reference, are only acknowledgements. Complete fresh listing is still required to count removal. Partial absence, missing arrays, errors and timeouts cannot prove removal. Accepted/in-flight interruptions become uncertain and are excluded from repeat approval until reconciled.

## Storage and error privacy

Local checkpoint fields are whitelisted: options, account identifier, numeric outcome IDs/status/timestamps, cooldown, counts/status. They may reveal activity and filter choices. Pending candidate lists, complete descriptions, credentials, CSRF and approval capabilities are excluded. Session storage contains the connected tab ID only. No sync storage is used.

Restore validates IDs/records/account/settings/cooldown and cannot start a job. Invalid options fall back to defaults. Invalid account-bound history is discarded. Source must be refreshed/rescanned after switching accounts; hydration content is not a cryptographic proof of live session identity.

Unknown status values and raw response bodies are not reflected into errors. Missing-list diagnostics contain only a fixed set of field names and types. Unexpected injected exceptions produce fixed bounded text. UI timeouts and stale polling do not replay actions.

## Remaining limitations

Live private-API signing may differ between isolated fetch and the reference's page-world fetch. No bypass or signing/session-token extraction is added. A successful fixture is not live API evidence. Actual extension registration/permissions, real storage quotas, tab suspension, TikTok enforcement, server-side cancellation and safe sustained rates need live validation.

A missing Reposts tab or missing list alone does not diagnose rate limiting. HTTP 429 does. Users should stop repeatedly scanning on unusable responses and wait before one read-only retest.

An accepted server action cannot be undone by abort. OS/renderer compromise, malicious other software, malicious server data or edited local extension files are outside this design. Existing page code can manipulate hydration DOM; no new page-triggered deletion channel is granted.

Source/syntax/manifest checks, 114 automated tests, eight intercepted-network Chrome scenarios, original-asset checks and installed Defender are recorded in VALIDATION.txt. Antivirus is supporting evidence only, not a browser-account authorization audit.
