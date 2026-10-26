Historical local-build note. Current release: 1.0.5; see README.md and RELEASE_NOTES.md. Earlier publication holds below were superseded by the user's 2026-10-26 upload request.

# Version 1.0.3 — dashboard-fix test build

This rebuild specifically addresses the difference between the working popup and the dashboard opened with its arrow button. The numeric manifest version stays 1.0.3; version_name and the footer identify the DASHBOARD FIX build. No GitHub publication has occurred.

## Identified issue

background.js trustedUI previously required both sender.url and sender.tab.url to equal the extension dashboard URL. sender.tab.url is optional metadata. A top-frame message from this extension's exact popup.html document was rejected when that metadata was absent. Two new regressions reproduced that rejection before the correction.

The corrected boundary requires the browser-supplied sender.id to be this extension, sender.url to equal this extension's exact popup.html URL, and the frame to be top-level when provided. Optional tab URL metadata is no longer a requirement. Websites cannot supply their own Chrome MessageSender fields. No permissions were broadened, no page-world/message bridge was added, and a raw file:/// copy of the HTML is not an authorized dashboard.

## Testing

80 Node tests pass, including the two previously failing dashboard cases and a test rejecting TikTok, local HTML, another extension and an embedded frame. The existing lease still directs all commands to the same connected TikTok tab, not to the dashboard tab.

The current browser test opens the popup, connects, clicks its arrow to open a second dashboard, closes the popup, sends dashboard messages with tab.id but no tab.url, scans, reviews an exact five-item batch, and processes/verifies all five fixture items. A separate ordinary-popup integration is also rerun. Chrome APIs and all TikTok traffic are mocked/intercepted in a fresh browser context; no personal account or real removal is used. Actual extension registration and the user's live browser require a retest.

## Try this rebuild

1. Refresh TikTok to interrupt the old job before reloading the extension. Accepted requests cannot be undone.
2. Reload the existing Repost Reset card at chrome://extensions. Retain that card so its local outcome history stays with the same installation.
3. Open the extension popup, Connect, and click the arrow in its top-right corner. Use this extension-created dashboard; do not double-click popup.html in File Explorer.
4. Confirm the new tab footer says v1.0.3 DASHBOARD FIX. Run a fresh read-only scan to reconcile uncertain earlier attempts.
5. Only when you choose, review and explicitly confirm a small batch. The dashboard should continue past the first request and show updated progress. Each later batch still needs a new confirmation.

The Downloads folders TikTokRepostRemoverCustom-1.0.2-test and TikTokRepostRemoverCustom-1.0.3-test are both updated so an existing card pointing to either folder can simply be reloaded. Before-update source backups have the suffix -before-dashboard-fix. This changes source files only, not Chrome profile settings.

The source ZIP is named TikTokRepostRemoverCustom-1.0.3-dashboard-test-source.zip to distinguish it from the earlier 1.0.3 test archive. GitHub remains on hold until the user confirms successful testing.
