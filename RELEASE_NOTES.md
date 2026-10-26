# Repost Reset 1.0.5 — reviewed source preview

Date: 2026-10-26. Includes the previously local 1.0.2–1.0.4 work and the fixes found in this review. Previous GitHub version: 1.0.1 at 4f3080494fabca6f668e7b2b68bb3f00b84a2521.

## Project and implementation

Source-only Chrome extension to list a signed-in user's TikTok reposts and remove exact, reviewed batches. It removes reposts, not original videos. No build, production dependency, tracking, developer server, remote scripts or automatic updater. Every batch requires fresh confirmation.

## Included changes since the last upload

1. **Stop/keep results:** abort discovery and retain individually validated candidates in memory for new review. Stop before valid results grants no eligibility.
2. **Remove found so far:** drain the active dry scan before preparing exact IDs; the button itself removes nothing.
3. **Progressive removal:** discover a page, review/confirm a batch, remove only those IDs and continue discovery. Every next batch asks again. Requests are sequential, and cursor pagination restarts after mutation to avoid skipping shifted items.
4. **Standalone dashboard:** the arrow opens the same extension UI in a tab, sharing the existing leased job after the popup closes. Valid sender documents are accepted when optional tab URL metadata is absent; TikTok, file HTML, other extensions and subframes remain unauthorized.
5. **Connection recovery:** tagged injected-command results/errors, compact status payloads, explicit stale-status display, Reconnect/Try to stop, and no action replay. Transient failure cannot move a still-open job to another TikTok tab.
6. **List compatibility:** explicit root/nested camel/snake list and pagination fields; one delayed first-page read-only retry; no arbitrary-array search or missing-list-as-empty assumption. Diagnostics contain fixed field names/types only. The exact earlier failing live response remains unknown.

## Additional bugs fixed during this review

7. **Request-spacing gaps:** per-loop waits did not cover every immediate approval or scan-to-first-removal boundary. A monotonic dispatch clock enforces configured spacing on every request, applies increased settings immediately and respects Pause/Stop.
8. **Cooldown checks:** now enforced independently at preparation, approval and dispatch. Extreme Retry-After stays finite through checkpoint serialization. Only HTTP 429 is reported as a confirmed rate limit; missing lists/tabs do not prove one.
9. **Interrupted accepted work:** both in-flight and accepted-but-unverified checkpoint outcomes become uncertain. No old approval, loop or pending list is restored.
10. **Malformed checkpoints:** invalid/null records and bad IDs are discarded; malformed settings fall back to defaults; invalid account-bound history and non-finite cooldowns are rejected instead of breaking agent initialization.
11. **Older uncertainty:** complete fresh verification now reconciles older uncertain attempts as well as the current batch. Presence proves remaining; incomplete absence never proves removal.
12. **Contradictory statuses:** a root success cannot conceal a nonzero nested POST status. GET/POST use strict success validation. Arbitrary server status text is no longer reflected into dashboard/history errors.
13. **Empty successful POST compatibility:** aligned with the reference's empty acknowledgement while still requiring full verification. Empty GET and malformed/non-JSON responses remain errors. No POST retry was added.
14. **Stale-poll race:** late read-only replies/errors can no longer overwrite a newer action or newly reconnected dashboard; an action revision discards obsolete polls.
15. **Unanswered UI commands:** a 30-second timeout releases busy state, leaves recovery controls available, states that the command may already have applied, and never resends it automatically.
16. **Approval deadline/dashboard errors:** expiry applies at the exact deadline; dashboard-opening failure produces a controlled error instead of an unhandled promise rejection.

## Reference and account protection

The requested reference was rechecked at b37346888f82262f46a25417c1fc68398d6009a0. Request endpoints, query/body/header fields, empty POST acknowledgements and pagination were compared. The reference's MAIN-world page-event authorization bridge and automatic POST retries were not copied. See UPSTREAM_REFERENCE.md.

Permissions remain scripting, storage, and only https://www.tiktok.com/*. No new credential handling, external destination, optional permission or production dependency. No password/cookie export, session-token extraction, credential persistence or personal profile use was introduced.

## Validation and limitations

See VALIDATION.txt, test-results/, REVIEW-2026-10-26.md and SECURITY.md for exact results and scope. Checks include regression tests for the identified bugs, real Chrome UI/isolated JavaScript with mocked APIs/intercepted requests, syntax/manifest checks, source/archive hashes and installed Defender.

These tests do not prove actual extension registration, live request signing/API compatibility, storage quotas under all conditions, account enforcement, a sustained safe request rate or absence of every bug. The user's suspected rate limit remains unconfirmed. This version is a **source preview**, not a claim of live account success.

## Setup, use and publication

Update the same loaded source folder, Reload the existing card, refresh TikTok, verify 1.0.5 and run a fresh read-only scan. Retain the same installation to keep local history. Only when you choose, review and confirm a small exact batch. Every later batch asks again. Never repeat uncertain attempts based on stale progress.

The user explicitly authorized publication on 2026-10-26, superseding the earlier upload hold. That does not authorize any account action. No live removal or normal-profile installation was performed during this review. Older published source ZIPs and repository history are preserved.
