# Upstream reference comparison

Rechecked 2026-10-26: [gabireze/tiktok-all-reposted-videos-remover](https://github.com/gabireze/tiktok-all-reposted-videos-remover), commit **b37346888f82262f46a25417c1fc68398d6009a0**. It is unchanged from the original complete audit.

- background.js Git blob: 481c04c7412a8dbd8a85ee8d64a78366c92e9870.
- script.js Git blob: 46746951f5dfba5ad306009503ee5a723be029d5.

Both match the original audited checkout. The reference was read, not installed/executed. Repost Reset remains separately authored with original icons; see THIRD-PARTY-NOTICE.md.

| Behavior | Comparison |
|---|---|
| List | Both GET https://www.tiktok.com/api/repost/item_list/ with aid=1988, count=30, coverFormat=2, exact cursor, needPinnedItemIds=true, post_item_list_request_type=0 and secUid. |
| Remove repost | Both POST https://www.tiktok.com/tiktok/v1/upvote/delete with aid=1988 and one item_id in query; empty body. |
| Headers/auth | Accept */*; removal content-type application/x-www-form-urlencoded and transient tt-csrf-token; browser credentials same-origin. Repost Reset requires CSRF instead of omitting it. |
| Mutating pagination | Restart cursor zero after removal, retaining deduplication, because deletion shifts positions. |
| Empty successful POST | Reference accepts it. Version 1.0.5 accepts the acknowledgement but counts removal only after complete fresh-list verification. Empty GET remains an error. |

## Deliberate security differences

The reference installs MAIN-world DOM removal-event listeners. Repost Reset does not copy that bridge: website scripts must not acquire authority to trigger deletions. Only the exact own-extension popup/dashboard document can send accepted commands, with top-frame restrictions, isolated execution, expiring per-batch capabilities and ID checks.

The reference can retry ambiguous removals. Repost Reset never automatically retries a POST: a missing response could hide an already-applied operation. Interruption is reconciled through listing, not replay. Missing lists are not assumed empty.

Page-world fetch in the reference may receive TikTok instrumentation/signing absent from isolated fetch. This is an unresolved live-compatibility limitation. This release does not extract signing/session tokens or bypass protections. Synthetic tests do not establish live API acceptance, and no real removal occurred during this review.
