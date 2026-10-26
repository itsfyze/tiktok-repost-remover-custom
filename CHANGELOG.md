# Changes

## 1.0.5 — reviewed source preview (2026-10-26)

- Publish previously local partial/Stop/progressive, dashboard, connection and list compatibility changes since GitHub 1.0.1.
- Enforce minimum request spacing across all dispatch/batch boundaries and cooldown before preparation, approval and dispatch.
- Restore accepted/in-flight attempts as uncertain; tolerate malformed checkpoints without restoring authority; reconcile older uncertainty during fresh verification.
- Reject contradictory nested statuses and omit raw status text. Match upstream successful empty POST acknowledgement while requiring full verification.
- Discard stale UI polls, bound unanswered commands to 30 seconds without replay, enforce exact expiry and handle dashboard opening errors.
- Recheck gabireze reference at b37346888f82262f46a25417c1fc68398d6009a0. Preserve isolated authorization, exact batches and no automatic POST retries.
- 114 Node tests and eight mocked Chrome scenarios pass; no live account actions. See RELEASE_NOTES.md and REVIEW-2026-10-26.md for complete evidence and unresolved live-API limits.

## 1.0.4 LIST FIX — local test only

- Accept one explicit root/nested camel/snake repost list with validated pagination; retain canonical behavior and strict video IDs.
- Retry an unusable successful first-page listing once after the configured delay, read-only at the same cursor. No auth/rate/HTTP/transport or deletion retry.
- Never infer an empty account or verified removal from an absent list. Reject conflicting formats and nonzero nested status codes.
- Show fixed field/type diagnostics without response values or sensitive data.
- Add 16 list regressions: 96 Node tests pass. Dashboard integration covers an initial missing list, recovery with a wrapped list, and complete verification of five fixture removals. No real account actions.
- Exact live format remains unknown; GitHub upload is still pending successful user testing.

## 1.0.3 dashboard-fix rebuild — local test only

- Fix valid standalone dashboard messages being rejected when optional sender.tab.url metadata is missing. Exact own-extension ID, own popup.html sender URL and top-frame restrictions remain mandatory.
- Preserve the same connected job when switching from popup to dashboard. No new permissions or automatic removal authority.
- Add three dashboard regressions, two failing before the fix: 80 Node tests pass. Add a Chrome integration that opens the dashboard through the arrow, closes the popup, and verifies all five fixture removals from that dashboard.
- Identify this rebuild with version_name and the v1.0.3 DASHBOARD FIX footer. Publication still waits for the user's successful retest.

## 1.0.3 — local connection-fix test build

- Return explicit bounded injected-command errors instead of a generic missing reply.
- Transfer compact status and exact reviewed-batch descriptions, rather than every discovered video and full history on every poll.
- Retry a missing read-only status response once; never automatically resend approval, removal or other action commands.
- Reconnect to the same existing job; a transient error cannot create a second job in another TikTok tab.
- Show connection loss and stale progress clearly, retain Reconnect and Try to stop, and clear the warning when contact returns.
- Add ten connection regressions: 77 Node tests pass. Mocked real-Chrome tests cover missing status after the first of five removals and stopping during missing replies.
- GitHub remains unchanged pending the user's successful retest. No live account actions were performed by development.

## 1.0.2 — local test build; publication pending user testing

- Stop discovery and keep individually validated results for a separately confirmed batch.
- Switch an active dry-run scan to review with Remove found so far; abort and drain scanning before removal can begin.
- Scan & remove as you go offers known batches before a full scan finishes. Each exact batch needs a fresh confirmation; listing and deletion requests remain sequential.
- Restart pagination after mutations to avoid skipping videos when list positions shift.
- Preserve strict account, session, rate-limit, storage, timeout and cancellation checks. Stop cannot restore eligibility after a safety error. Accepted but unverified attempts stay uncertain.
- Count videos newly discovered during verification and label the count Reposts found.
- 67 Node tests and five mocked real-Chrome scenarios cover new controls and existing behavior. No personal account or real removal was used.
- GitHub upload/release waits for the user's test results.

## 1.0.1

- Retain validated repost IDs after a later successful JSON response has an unexpected list or pagination structure.
- Allow explicit confirmation of a batch from those known results; keep full totals unknown and show a partial-scan warning.
- Accept boolean, numeric and explicit string pagination flags without truthiness errors.
- Exclude malformed video IDs and never guess that missing pagination means the scan is complete.
- Continue blocking removal after auth/session, rate-limit, transport, raw JSON or security errors.
- Require complete verification to prove removal; partial absence stays uncertain and is excluded from a further batch until rescanned.
- Reject an outdated isolated agent until the TikTok tab is refreshed after updating the extension.
- Add 14 regression tests for partial listings and verification; no actual account actions performed during testing.

## 1.0.0

Initial source-only release with isolated authorization, per-batch confirmation, cancellation and local checkpoints.
