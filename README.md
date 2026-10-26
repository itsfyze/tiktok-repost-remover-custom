# Repost Reset 1.0.5

Source-only Chrome extension for listing TikTok reposts and removing exact, reviewed batches. Removing a repost does not delete the original video.

**Reviewed source preview:** automated tests and intercepted-network Chrome scenarios pass. Live TikTok compatibility, account enforcement and a sustained safe request rate are not established by those tests. No claim of zero bugs is made. See [release notes](RELEASE_NOTES.md), [review findings](REVIEW-2026-10-26.md), [security review](SECURITY.md) and [reference comparison](UPSTREAM_REFERENCE.md).

## Install or update

No compilation, production dependencies, subscription or developer server is required. Use source files directly, not a Web Store extension or precompiled CRX.

For an existing installation:

1. Stop work. If the old dashboard is unresponsive, refresh TikTok to interrupt it. Accepted requests cannot be undone.
2. Back up the already-loaded source folder, then replace its files with this version. Keep the same extension card/folder to retain local outcome history.
3. Open chrome://extensions and click **Reload** on that card. Refresh TikTok and close old dashboard tabs.
4. Open the popup, verify **v1.0.5**, Connect, then optionally use the arrow to open the dashboard in a tab.
5. Run a fresh read-only scan to reconcile uncertain previous attempts. Do not immediately repeat an old uncertain batch.

For a first installation, enable Developer mode at chrome://extensions, choose **Load unpacked**, and select the folder containing manifest.json. Check Chrome reports no errors and matches the permissions below. Open the dashboard through the extension; double-clicking popup.html in File Explorer does not create an authorized extension page.

The source ZIP and SHA-256 are under dist/ in the GitHub repository. Keep archives and backups outside the loaded source directory. The prepared local folder is Downloads/TikTokRepostRemoverCustom-1.0.5.

## Use

Open your own profile at https://www.tiktok.com, sign in yourself, keep that tab open, and Connect. The extension never signs you in or asks for your password. After switching accounts, refresh TikTok and scan again.

- **Scan reposts · dry run:** discovery only; no removal is authorized. The website's Reposts tab does not need to be visible or clicked.
- **Stop scan & keep results:** abort discovery and retain validated candidates in memory; full totals remain unknown.
- **Remove found so far…:** stop/drain an active dry scan, then prepare known results for review. The button itself deletes nothing.
- **Start removing…:** prepare a filtered batch from complete/eligible partial results. Review every ID, check the acknowledgement and explicitly confirm. Approval expires after five minutes and applies to that batch only.
- **Scan & remove as you go…:** discover, wait for batch review/confirmation, remove those exact IDs, and continue discovery. Every further batch asks again. Listings/removals never overlap; pagination restarts after mutation. The configured cap applies to each batch, not the entire session.
- **Pause / Resume:** block subsequent dispatch; an in-flight request may finish. **Stop** aborts requests and waiting work, but cannot undo an accepted action.

The five-second default delay is configurable from 3–120 seconds and enforced across request/batch boundaries. Batch caps are 1–1000, with optional case-insensitive description keywords. These are local bounds, not TikTok-approved rates.

**Verified removed** requires a complete fresh listing proving absence. A successful POST acknowledgement, including an empty successful response, is not proof. Partial absence remains uncertain; presence proves still listed. Uncertain attempts are excluded from repeat approval until a fresh listing reconciles them. In progressive mode, full verification follows discovery, so accepted operations may remain unverified until then.

## Errors and recovery

HTTP **429** halts work and honors Retry-After (minimum 60 seconds; one-hour fallback). Cooldown is checked before preparation, approval and dispatch. Nothing resumes deletion automatically. A missing list or website tab alone does not confirm a rate limit. Avoid repeatedly scanning when TikTok returns unusable data.

401/403, challenges, nonzero statuses, transport errors, timeouts and non-JSON listings halt. No security/signing bypass is attempted. A successful first-page JSON response without a usable list gets at most one delayed read-only retry at the same cursor. POSTs are never automatically retried.

Only explicitly named root/data itemList or item_list arrays with explicit pagination are supported. Missing/ambiguous lists never establish a complete empty account. Previously validated results can remain partial after a later structural failure. Diagnostics contain fixed field names/types, not response values or tokens.

Lost contact labels counters as last known, leaves **Reconnect** and **Try to stop** available, and disables new approvals. Reconnect checks the same job without replaying removal. An unanswered UI command times out after 30 seconds; it may already have applied. Refresh TikTok to interrupt an unreachable agent, then reconnect and scan to reconcile.

## Permissions and data

| Permission | Purpose |
|---|---|
| scripting | Inject/invoke local isolated-world agent, frame zero, on explicit Connect. |
| storage | Local settings/outcomes and session connected-tab lease. |
| https://www.tiktok.com/* | Exact HTTPS host for the selected tab and same-origin requests. |

No cookies, tabs, history, debugger, downloads, clipboard, wildcard hosts or optional permissions. No tracking, external server, remote script, sync storage or automatic updater. Browser cookies go only to TikTok without code reading/exporting them. CSRF stays transient in isolated memory and goes only to TikTok's removal endpoint.

Local checkpoints contain account identifier, video outcomes, options and cooldown. This can reveal activity/keywords; do not publish checkpoints. Approvals, running loops, pending candidates, full descriptions and credentials are not restored.

## Development checks

Run with an existing Node installation; no dependencies needed:

    node --test ./tests/*.test.cjs

Optional browser integration uses already-installed Chrome and Playwright. Set PLAYWRIGHT_MODULE to that existing module's path, optionally CHROME_PATH and TEST_OUTPUT, then:

    node ./tests/browser-smoke.cjs

Use a fresh shell/unset previous fixture variables. Options: REPOST_PARTIAL_FIXTURE=1; REPOST_INTERACTIVE_FIXTURE=stop|switch|stream; REPOST_CONNECTION_FIXTURE=1|stop; or REPOST_DASHBOARD_FIXTURE=1 with optional REPOST_LIST_FIXTURE=transient.

Tests use actual Chrome UI/isolated JavaScript but mocked extension APIs and intercepted TikTok responses. They do not establish actual extension registration, real storage quotas, live API signing or account behavior. Original icons can be regenerated with tools/generate-icons.cjs. No production build is required.

Historical local-build notes are retained as history; this README and the 1.0.5 notes describe the current version.
