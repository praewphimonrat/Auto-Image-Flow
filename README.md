# Google Labs Flow Helper

Skeleton Chrome extension for pages that match:

- `https://labs.google/fx/th/tools/flow/project/*`

## Files

- `manifest.json`: Extension config for Manifest V3
- `background.js`: Background service worker placeholder
- `content.js`: Content script that mounts a right-side panel and keeps the page inset in sync
- `flow-page-actions.js`: Page automation helpers for prompt input, progress waiting, download, and delete
- `queue-panel.js`: Prompt queue UI, persistence, and automation loop controller
- `content.css`: Injected styles for the docked panel and reserved page space
- `popup.html`, `popup.css`, `popup.js`: Simple popup UI scaffold

## Current behavior

- A docked panel appears on the right side of matching Flow project pages
- The panel can be opened and closed from its own toggle button
- When the panel is open, the extension reserves space on the right so the Flow page is pushed left instead of being covered
- When the panel is closed, a floating `Open panel` button stays on the right edge so you can bring it back
- The panel now includes a prompt textarea, queue list, start or pause controls, and queue persistence in `chrome.storage`
- Queue processing follows this flow: fill prompt, click send, wait for progress to disappear, click download, click delete, confirm delete
- If the current stage fails 3 times and has not recovered yet, the page refreshes once and then resumes from the saved queue state

## Load in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `google-fx-flow-extension` folder

## Next ideas

- Replace the placeholder panel in `content.js` with your real UI
- Add message passing between popup, background, and content script
- Expand `host_permissions` if you want the extension to support more locales or related pages
