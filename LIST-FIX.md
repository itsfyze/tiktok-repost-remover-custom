Historical local-build note. Current release: 1.0.5; see README.md and RELEASE_NOTES.md. Earlier publication holds below were superseded by the user's 2026-10-26 upload request.

# Repost Reset 1.0.4 LIST FIX — local test build

The screenshot reports a successful JSON response without the itemList array expected by the scanner. The screenshot does not reveal the actual response structure, and no raw authenticated response or tokens were requested. The list parser was unchanged between the working 1.0.2 build and the dashboard correction; the exact live cause remains unknown.

This update accepts one explicit list from root.itemList, root.item_list, data.itemList or data.item_list, with matching explicit camel/snake pagination fields. It does not recursively search arbitrary arrays, guess IDs, or interpret absent video data as a complete empty list. Conflicting lists, flags or cursors cannot establish complete discovery. All individual video IDs still require numeric strings. Nonzero root or nested status codes halt, even if an array exists.

If the first successful JSON response contains no usable list, the scanner waits the configured delay and retries that same read-only page once. This does not apply to session, HTTP, rate-limit, transport or raw JSON errors, or to deletion requests. A later malformed page preserves previously validated results as partial, without extra retry. Missing verification data never proves a removal. Stop cancels the retry and never grants deletion authority.

If both first-page reads fail, the message includes only the names and types of four allowed list fields. It contains no arbitrary field names, response values, credentials, cookies, IDs, CSRF token or request headers. Share only that error text if it recurs. Do not export authenticated traffic.

## Retest

1. Refresh TikTok to interrupt the old job, close the old dashboard tab, and Reload the existing Repost Reset card at chrome://extensions. The prepared Downloads source folders retain their names (1.0.2-test and 1.0.3-test), but their source now identifies version 1.0.4. Keep the same card to retain local outcome history.
2. Open your own TikTok profile and its Reposts tab. Open the extension popup, Connect, then use its arrow to open the dashboard.
3. Check the footer says v1.0.4 LIST FIX. Run Scan reposts · dry run first. A missing first-page list triggers one delayed read-only retry.
4. If it still fails, send the new error message. Its fixed field/type summary will distinguish an unsupported envelope from missing video data, without exposing sensitive values. The extension must not remove anything based on that failure.
5. Only if you choose to remove known videos, review and explicitly approve a small batch. Every later batch still needs its own confirmation.

## Evidence and limits

96 Node tests pass: the earlier 80 plus 16 list-format tests. Coverage includes named formats, explicit empty arrays, one bounded retry, conflicting schemas, nested rejection, pagination, unknown arrays, diagnostic privacy, missing verification data and cancellation. Browser integration uses fake TikTok data and mocked Chrome APIs in a fresh Chrome context: the dashboard opens via the arrow, the popup closes, a missing initial list recovers on the delayed retry, and five exact fixture removals finish with complete verification. The ordinary-popup scenario also passes. No real account action was performed.

These explicit formats are compatibility cases covered by synthetic fixtures; their presence in the user's live failing response has not been confirmed. No new permission, dependency, credential storage, external destination, remote code or page-world bridge was added. Source was reviewed, syntax checked and scanned with installed Defender. See VALIDATION.txt. GitHub publication remains on hold pending successful user testing.
