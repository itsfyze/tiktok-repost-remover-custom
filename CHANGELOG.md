# Changes

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
