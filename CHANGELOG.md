# chat-adapter-wechat

## 0.3.3

### Patch Changes

- [#8](https://github.com/sang4lv/chat-adapter-wechat/pull/8) [`3201dc5`](https://github.com/sang4lv/chat-adapter-wechat/commit/3201dc5d912c482f1af8fe2a2af985f23a6de4a5) Thanks [@sang4lv](https://github.com/sang4lv)! - Fix ACP polling interval handling so `pollIntervalMs` throttles empty `getupdates` responses instead of being used as the HTTP request timeout. Non-empty responses are polled again immediately so incoming backlogs can drain without an artificial delay, while `getupdates` keeps a dedicated long-poll request timeout above the server hold window.

## 0.3.2

### Patch Changes

- [#6](https://github.com/sang4lv/chat-adapter-wechat/pull/6) [`efaa07d`](https://github.com/sang4lv/chat-adapter-wechat/commit/efaa07d790e01406ec5d5815a80e8d022e6bab03) Thanks [@sang4lv](https://github.com/sang4lv)! - Fix isMe check using wrong identity — applyAccount now sets botUserId to account.botId (the iLink bot identity) instead of account.userId (the WeChat OpenID of the QR scanner), which caused all incoming user messages to be incorrectly flagged as bot-authored and dropped.

## 0.3.1

### Patch Changes

- [#4](https://github.com/sang4lv/chat-adapter-wechat/pull/4) [`82f5f8b`](https://github.com/sang4lv/chat-adapter-wechat/commit/82f5f8b76062343b6e3a482fd1d740a394ac2523) Thanks [@sang4lv](https://github.com/sang4lv)! - Comprehensive logging across ACP and Bot adapters.

  Both `IlinkClient` and `BotClient` now accept an optional `logger` and
  log HTTP errors, rate limits, token refresh, CDN failures, and
  decryption fallbacks. The ACP adapter logs message enqueue/drain
  lifecycle, outbound sends, image uploads, typing failures, and
  file-based persistence errors that were previously swallowed silently.
  The Bot adapter logs outbound queries and disconnect. All logger
  metadata passes raw error objects instead of `String(error)` to
  preserve stack traces.

## 0.3.0

### Minor Changes

- [#2](https://github.com/sang4lv/chat-adapter-wechat/pull/2) [`b09f333`](https://github.com/sang4lv/chat-adapter-wechat/commit/b09f33384e1742d9b8b60b5989aef0e6950393c6) Thanks [@sang4lv](https://github.com/sang4lv)! - ACP mode: crash resilience, multi-bot gateways, split scan/polling.

  **Crash resilience.** The ACP adapter now durably persists every message
  in a `getupdates` batch to the chat-sdk state queue _before_ advancing
  the iLink long-poll cursor. iLink does not redeliver messages once the
  cursor moves, so the previous fire-and-forget dispatch could lose
  messages on instance crashes mid-batch. Persistence requires a
  `StateAdapter` that implements `enqueue` / `dequeue` / `queueDepth`
  (state-memory and state-pg both qualify).

  **Multi-bot gateway support.** New optional `botId` and `metadata`
  options on `createWeChatAcpAdapter`. `botId` scopes the adapter `name`,
  the durable pending queue key, and the default `dataDir` so multiple
  adapters can coexist behind one `Chat` and one shared state backend
  without colliding. `metadata` is opaque caller-supplied data surfaced
  unchanged via `onQrCode` / `onAuthFailure` callback contexts and as
  `(message.adapter as WeChatAcpAdapter).metadata` for handler-side
  lookup. Both options are optional — single-bot deployments are
  unchanged.

  **Split scan and polling across processes.** New
  `loginWithQr(): Promise<AccountData>` runs only the QR scan flow and
  persists `AccountData` via `accountStorage` — no `Chat` instance
  needed, safe to call from a dedicated scan worker. New
  `initialize(chat, { requireExistingAccount: true })` refuses to scan
  and throws if no account is in storage, intended for headless polling
  workers whose credentials were provisioned earlier in another process.

  **Auth failure handoff.** New optional `onAuthFailure` callback. When
  configured, an iLink 401/403 stops polling cleanly after running the
  callback (instead of attempting an in-process re-scan). Use this in
  headless workers to delete stale credentials and signal a separate
  scan worker to re-onboard out-of-band.

  **Signature changes (additive, non-breaking).** `onQrCode` now receives
  a second `context: { botId?, metadata? }` argument; existing
  single-argument callbacks continue to work. New exports from
  `chat-adapter-wechat/acp`: `AccountData`, `PollState`, `WeChatStorage`.

## 0.2.0

### Minor Changes

- [`0080f71`](https://github.com/sang4lv/chat-adapter-wechat/commit/0080f7164505efe062706eea81b70305203b25a2) Thanks [@sang4lv](https://github.com/sang4lv)! - Add custom storage support for ACP adapter via `accountStorage` and `stateStorage` callbacks, allowing persistence to databases or other backends instead of the filesystem
