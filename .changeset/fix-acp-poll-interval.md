---
"chat-adapter-wechat": patch
---

Fix ACP polling interval handling so `pollIntervalMs` throttles empty `getupdates` responses instead of being used as the HTTP request timeout. Non-empty responses are polled again immediately so incoming backlogs can drain without an artificial delay, while `getupdates` keeps a dedicated long-poll request timeout above the server hold window.
