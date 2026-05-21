# chat-adapter-wechat

WeChat adapter for the [Vercel Chat SDK](https://github.com/vercel/chat). Supports two integration modes:

- **ACP mode** (`chat-adapter-wechat/acp`) — connects via the ilink bot API (QR login, polling)
- **Bot mode** (`chat-adapter-wechat/bot`) — connects via the official dialog platform (APPID/Token/AESKey)

## Installation

```bash
npm install chat-adapter-wechat chat @chat-adapter/shared
```

## Usage

### ACP Mode (ilink)

ACP mode supports two access patterns:

- **Single bot** — one adapter instance, one bot, one process. Scan and
  polling happen in the same lifecycle. Use this if you have one bot or
  a small fixed set of bots.
- **Multi-bot gateway** — N adapter instances behind one `Chat`, each
  identified by a caller-supplied `botId`. Use this if you have several
  bots and want a single shared dispatcher / state backend. Scan and
  polling can also be split across processes.

#### Single bot (one process)

```typescript
import { Chat } from "chat";
import { createWeChatAcpAdapter } from "chat-adapter-wechat/acp";
import { createMemoryState } from "@chat-adapter/state-memory";

const wechat = createWeChatAcpAdapter({
  onQrCode: (qr) => {
    // Send qr.imageBase64 to wherever you want the operator to scan it.
    // In dev you might write it to a file or open it in a browser.
  },
});

const chat = new Chat({
  adapters: { wechat },
  state: createMemoryState(),
  userName: "MyBot",
});

chat.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

await chat.initialize();
// First run: scans QR via onQrCode, persists AccountData, starts polling.
// Subsequent runs: loads persisted AccountData, skips scan, starts polling.
```

`message.adapter` is the `WeChatAcpAdapter` instance you created, so you
don't need any extra plumbing to know which bot is which (there's only
one).

#### Crash resilience (ACP mode)

Unlike webhook-based adapters (Slack, Telegram, Discord, …) where the
platform retries delivery on failure, iLink long-polling is destructive:
once a `getupdates` call returns successfully, its internal cursor is
advanced and those messages are gone forever.

To survive instance crashes, the ACP adapter durably persists every
message in a `getupdates` batch to the chat-sdk state queue **before**
advancing its local cursor. Concretely:

1. `getupdates` returns batch `[m1, m2, m3]`.
2. Each message is enqueued via `state.enqueue("wechat-acp:pending", …)`
   (or `"wechat-acp:pending:${botId}"` in multi-bot deployments — see
   [Multi-bot gateway](#multi-bot-gateway)).
3. Only after every message is persisted is the cursor saved.
4. A background drainer pops from the pending queue and dispatches each
   message via `chat.processMessage`. Chat-sdk's built-in dedupe handles
   the case where step 1 succeeded but a crash before step 3 caused the
   same batch to be re-fetched on a fresh instance.

**Required state-adapter capabilities.** This guarantee depends on the
chat-sdk `StateAdapter` implementing `enqueue`, `dequeue`, and
`queueDepth`. The bundled `@chat-adapter/state-memory` and
`@chat-adapter/state-pg` adapters both qualify. A pure key/value backend
that does not implement queue methods cannot provide the durability
guarantee.

**Known caveat.** State-pg's `dequeue()` is destructive (single
`DELETE … RETURNING`, no visibility timeout or lease). A crash *after*
the drainer has dequeued a message but *before* its handler completes
will still lose that message. Adding lease semantics to the state
adapter layer is tracked separately and is out of scope for this
adapter.

#### Multi-bot gateway

To run several WeChat bots behind a single `Chat` instance, pass a
distinct `botId` to each adapter. The adapter uses it to scope every
piece of per-bot state that would otherwise collide:

- `adapter.name` becomes `wechat-acp:${botId}`, so chat-sdk's per-adapter
  dedupe and lock keys don't collide.
- The durable pending queue key becomes `wechat-acp:pending:${botId}`,
  so each bot's drainer only sees its own messages even when several
  adapters share a single state backend.
- `onQrCode` is called with a second argument `{ botId, metadata }`,
  so the gateway can route the QR image to the correct frontend
  without needing a closure per bot.
- The default `dataDir` is scoped to `~/.chat-adapter-wechat/${botId}`
  so `account.json` and `state.json` don't overwrite each other.
- Handlers recover the bot id from the adapter attached to the message:
  `(message.adapter as WeChatAcpAdapter).botId`.
- For arbitrary per-instance context (tenant id, display name, region,
  etc.), pass `metadata` at construction time. The adapter never reads
  it — it just surfaces it back via `onQrCode` / `onAuthFailure`
  callback contexts and as `(message.adapter as WeChatAcpAdapter).metadata`.
  Think of `botId` as the *key* (used for state scoping) and `metadata`
  as the *value* (opaque user data).

> The caller-supplied `botId` is your own logical identifier. It is
> **not** embedded in the QR code image (iLink generates the QR payload
> server-side and you cannot put data inside it). Instead, the adapter
> instance you created knows which bot it belongs to, and threads that
> id back to you via `onQrCode` and `message.adapter.botId`. iLink's
> own `ilink_bot_id` (returned after a successful scan and saved into
> `AccountData`) identifies the *scanning WeChat account*, not your
> logical bot — keep them mentally separate.

##### All bots provisioned in one process

```typescript
import { Chat } from "chat";
import {
  createWeChatAcpAdapter,
  type WeChatAcpAdapter,
} from "chat-adapter-wechat/acp";

type BotMeta = { tenantId: string; displayName: string };

const bots: { sales: BotMeta; support: BotMeta; ops: BotMeta } = {
  sales:   { tenantId: "tenant_1", displayName: "Sales Bot" },
  support: { tenantId: "tenant_2", displayName: "Support Bot" },
  ops:     { tenantId: "tenant_3", displayName: "Ops Bot" },
};

const adapters = Object.entries(bots).map(([botId, metadata]) =>
  createWeChatAcpAdapter({
    botId,
    metadata, // opaque to the adapter; surfaced back to you in callbacks
    onQrCode: (qr, ctx) => {
      // ctx.botId    === "sales" | "support" | "ops"
      // ctx.metadata === BotMeta for that bot
      const meta = ctx.metadata as BotMeta;
      myApp.publishQr(meta.tenantId, meta.displayName, qr.imageBase64);
    },
  })
);

const chat = new Chat({
  adapters: {
    "wechat-sales": adapters[0],
    "wechat-support": adapters[1],
    "wechat-ops": adapters[2],
  },
  state: createPgState({ connectionString: process.env.DATABASE_URL }),
  userName: "MyBot",
});

chat.onDirectMessage(async (thread, message) => {
  const adapter = message.adapter as WeChatAcpAdapter;
  const meta = adapter.metadata as BotMeta;
  // adapter.botId === "sales" | "support" | "ops"
  // meta.tenantId, meta.displayName both available
  await thread.post(`Reply from ${meta.displayName}: ${message.text}`);
});

// Bring each adapter online — scans on first run, resumes on later runs.
await chat.initialize();
```

##### Split scan and polling across processes

When the scan UI lives in a separate process (e.g. an admin web app)
from the long-running polling worker, use `startQrLogin()` (or its
convenience wrapper `loginWithQr()`) on the scan side and
`initialize(chat, { requireExistingAccount: true })` on the polling
side. Both processes point at the same shared `accountStorage` so
credentials flow between them via the database.

**Scan worker — onboard a bot from an HTTP handler:**

The decoupled `startQrLogin()` API is the right tool for HTTP scan
flows. It returns the QR image immediately and a deferred `result`
promise that the handler can fire-and-forget — the HTTP request
closes right away instead of holding the connection open for the
entire scan window.

```typescript
import { createWeChatAcpAdapter, type QrLoginError } from "chat-adapter-wechat/acp";

app.post("/wechat/onboard/:botId", async (req, res) => {
  const { botId } = req.params;
  const wechat = createWeChatAcpAdapter({
    botId,
    accountStorage: pgAccountStorage(botId), // your shared store
  });

  // Fetches the QR code, kicks off polling in the background, returns
  // immediately. AccountData is persisted to pgAccountStorage on success.
  const session = await wechat.startQrLogin();

  // Return the image to the frontend right away.
  res.json({ qr: session.qrcode.imageBase64 });

  // Hand off the eventual scan result. Errors are typed as QrLoginError
  // with a discriminated `code` field. The result promise has an
  // internal .catch() so an unobserved rejection cannot crash Node.
  session.result
    .then((account) => notifyOpsScanned(botId, account.botId))
    .catch((err: QrLoginError) => {
      if (err.code === "expired") notifyOpsExpired(botId);
      // err.code === "cancelled" fires if you stop the bot mid-scan
    });
});
```

**Bound the scan window with your own timer.** The adapter does not
impose a wall-clock deadline — it polls until iLink reports `expired`,
the scan succeeds, you call `cancel()`, or the bot is shut down. If
you want a hard deadline (e.g. give the operator 30 minutes to walk
to their phone), race `result` against your own timer and cancel from
the loser:

```typescript
const session = await wechat.startQrLogin();
const account = await Promise.race([
  session.result,
  new Promise<never>((_, rej) =>
    setTimeout(() => {
      session.cancel(); // also rejects session.result with code: "cancelled"
      rej(new Error("operator did not scan within 30 minutes"));
    }, 30 * 60 * 1000)
  ),
]);
```

**Interactive / single-process onboarding** can use the convenience
wrapper `loginWithQr()`, which fires the configured `onQrCode`
callback and awaits the result inline:

```typescript
async function onboardBotInteractive(botId: string) {
  const wechat = createWeChatAcpAdapter({
    botId,
    accountStorage: pgAccountStorage(botId),
    onQrCode: (qr, ctx) => {
      myApp.publishQr(ctx.botId!, qr.imageBase64);
    },
  });
  const account = await wechat.loginWithQr();
  console.log("Onboarded", account.botId);
}
```

**Polling worker — start polling for an already-onboarded bot:**

```typescript
import { Chat } from "chat";
import {
  createWeChatAcpAdapter,
  type WeChatAcpAdapter,
} from "chat-adapter-wechat/acp";

async function startBotPolling(botId: string) {
  const wechat = createWeChatAcpAdapter({
    botId,
    accountStorage: pgAccountStorage(botId),
    stateStorage:   pgStateStorage(botId),
    onAuthFailure: async (ctx) => {
      // Bot token expired or was revoked. Polling stops cleanly after
      // this callback returns. Hand off to your scan worker — e.g.
      // delete the AccountData row, mark the bot as needing
      // re-onboarding, and page the operator.
      await markBotForReonboarding(ctx.botId!);
    },
  });

  const chat = new Chat({
    adapters: { [`wechat-${botId}`]: wechat },
    state: pgChatState,
    userName: "MyBot",
  });

  chat.onDirectMessage(async (thread, message) => {
    const botId = (message.adapter as WeChatAcpAdapter).botId;
    await thread.post(`Reply from ${botId}: ${message.text}`);
  });

  // Throws if pgAccountStorage has no row for this botId.
  await wechat.initialize(chat, { requireExistingAccount: true });
}
```

##### What to persist (per bot)

Two records, both keyed by your logical `botId`. The adapter exposes
storage hooks for each:

| Hook | Type | Written by | Read by | Contents |
|------|------|------------|---------|----------|
| `accountStorage` | `WeChatStorage<AccountData>` | scan side (`startQrLogin` or `loginWithQr`) | polling side (`initialize`) | `botToken`, iLink `botId` / `userId`, `baseUrl`, `savedAt` |
| `stateStorage` | `WeChatStorage<PollState>` | polling side (continuously) | polling side (on restart) | `updatesBuf` (long-poll cursor), `contextTokens`, `lastMessageId` |

`updatesBuf` is the load-bearing field — losing it means the next poll
restarts from a stale cursor. `contextTokens` and `lastMessageId` are
best-effort: losing them only degrades reply context for in-flight
conversations and doesn't lose messages.

Both interfaces are simple `load() / save()` pairs. Plug them into your
shared store of choice:

```typescript
const pgAccountStorage = (botId: string) => ({
  load: () => db.query("SELECT data FROM wechat_accounts WHERE bot_id = $1", [botId]).then(r => r.rows[0]?.data ?? null),
  save: (data: AccountData) => db.query("INSERT INTO wechat_accounts ... ON CONFLICT ...", [botId, data]),
});
```

##### Auth failures and token expiry

iLink signals an expired or revoked bot token via HTTP 401/403 on the
next `getupdates` call, which the adapter surfaces as an
`AuthenticationError`. Behavior:

- **`onAuthFailure` configured (recommended for headless workers):**
  the callback runs once with `{ botId, metadata }`, then the polling
  loop stops cleanly. Re-onboarding must happen out-of-band by calling
  `startQrLogin()` from your scan worker (or `loginWithQr()` if your
  scan worker is interactive). There is no in-band warning before
  expiry — the first signal is the 401.
- **`onAuthFailure` NOT configured (legacy single-process behavior):**
  the polling loop attempts an in-process `loginWithQr()` to recover.
  Fine for interactive single-bot deployments; wrong for headless
  workers because it would try to surface a QR in a process that has no
  way to display one.

### Bot Mode (Official Dialog Platform)

```typescript
import { Chat } from "chat";
import { createWeChatBotAdapter } from "chat-adapter-wechat/bot";
import { createMemoryState } from "@chat-adapter/state-memory";

const wechat = createWeChatBotAdapter({
  appId: process.env.WECHAT_APP_ID!,
  token: process.env.WECHAT_TOKEN!,
  aesKey: process.env.WECHAT_AES_KEY!,
});

const chat = new Chat({
  adapters: { wechat },
  state: createMemoryState(),
  userName: "MyBot",
});

chat.onNewMention(async (thread, message) => {
  // postMessage sends the user's text as a /v2/bot/query request
  // and returns the chatbot platform's response
  await thread.post(message.text);
});

await chat.initialize();
```

## Configuration

### ACP Mode

All options are optional — defaults are shown below.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `botId` | `string` | — | Optional logical bot identifier for multi-bot gateways. Drives `name`, pending-queue partition, default `dataDir`. (see [Multi-bot gateway](#multi-bot-gateway)) |
| `metadata` | `Record<string, unknown>` | — | Opaque caller-supplied data attached to this adapter. Surfaced via `onQrCode` / `onAuthFailure` callback contexts and as `adapter.metadata`. The adapter never reads it. |
| `dataDir` | `string` | `~/.chat-adapter-wechat` (or `~/.chat-adapter-wechat/<botId>` when `botId` is set) | Directory for token and state persistence |
| `pollIntervalMs` | `number` | `25000` | Delay before retrying after an empty `getupdates` response |
| `typingIntervalMs` | `number` | `15000` | Typing indicator heartbeat in milliseconds |
| `baseUrl` | `string` | `https://ilinkai.weixin.qq.com` | ilink API base URL |
| `cdnBaseUrl` | `string` | `https://novac2c.cdn.weixin.qq.com/c2c` | CDN base URL for media |
| `onQrCode` | `(qr, ctx: { botId?, metadata? }) => void` | — | Callback when a QR code is generated for login. `ctx.botId` and `ctx.metadata` are the values passed to `createWeChatAcpAdapter`. |
| `onAuthFailure` | `(ctx: { botId?, metadata? }) => void \| Promise<void>` | — | Called once when iLink returns 401/403 during polling. After it resolves the polling loop stops cleanly. Use to hand off to a separate scan worker for re-onboarding. When unset, the adapter falls back to an in-process `loginWithQr()` for legacy single-process deployments. |
| `accountStorage` | `WeChatStorage<AccountData>` | — | Custom persistence for account credentials (replaces disk). Required when running scan and polling in separate processes. |
| `stateStorage` | `WeChatStorage<PollState>` | — | Custom persistence for poll state (replaces disk). |
| `logger` | `Logger` | Console logger | Custom logger instance |

#### Lifecycle methods

| Method | When to use |
|--------|-------------|
| `startQrLogin(): Promise<QrLoginSession>` | **Headless / split-process scan flows.** Returns immediately with `{ qrcode, result, cancel }` so an HTTP handler can ship the QR image and let the scan resolve in the background. The polling loop runs until iLink reports `expired`, `cancel()` is called, the scan succeeds, or `disconnect()` cancels in-flight sessions. The `result` promise has an internal `.catch()` so an unobserved rejection cannot crash Node via `unhandledRejection`. |
| `loginWithQr(): Promise<AccountData>` | **Interactive / single-process onboarding.** Convenience wrapper around `startQrLogin()`: fetches the QR, fires `onQrCode`, awaits `session.result` inline. No `Chat` instance needed. |
| `initialize(chat)` | Single-process: load existing `AccountData` or scan if missing, then start polling. |
| `initialize(chat, { requireExistingAccount: true })` | Polling-worker: start polling against an `AccountData` provisioned earlier by `loginWithQr` / `startQrLogin` (typically in another process). Throws if no account is in `accountStorage`. |
| `disconnect()` | Stop polling, drain shutdown signal to the pending-queue drainer (so a large backlog doesn't block disconnect), cancel any in-flight `startQrLogin` sessions, and flush state. |

`QrLoginError` is the rejection type of `session.result` and carries a discriminated `code: "expired" \| "cancelled" \| "network"` so you can branch on the cause without string-matching. Both `QrLoginError` and `QrLoginSession` are exported from `chat-adapter-wechat/acp`.

```typescript
createWeChatAcpAdapter({
  pollIntervalMs: 10000,
  onQrCode: (qr) => {
    console.log("QR image base64:", qr.imageBase64);
  },
  // Optional: custom storage instead of filesystem
  accountStorage: {
    load: async () => db.get("wechat-account"),
    save: async (data) => db.set("wechat-account", data),
  },
});
```

### Bot Mode

```typescript
createWeChatBotAdapter({
  appId: process.env.WECHAT_APP_ID!,   // Required — dialog platform app ID
  token: process.env.WECHAT_TOKEN!,     // Required — dialog platform token
  aesKey: process.env.WECHAT_AES_KEY!,  // Required — dialog platform AES key
  baseUrl: "https://openaiapi.weixin.qq.com", // Optional — API base URL
  env: "online",                        // Optional — "online" (default) or "debug"
});
```

## Supported Features

| Feature | ACP Mode | Bot Mode |
|---------|----------|----------|
| Text messages | Send + Receive | Query/Response |
| Image messages | Send + Receive | Response only |
| Typing indicators | Yes | No |
| Referenced messages | Yes | No |
| Message history | SDK-managed | SDK-managed |
| QR code login | Yes | N/A (token-based) |
| Group chat | Yes | N/A |

## Architecture

Single package with two entrypoints:

```
chat-adapter-wechat/acp  → createWeChatAcpAdapter()
chat-adapter-wechat/bot  → createWeChatBotAdapter()
```

Both modes share a common base adapter (`WeChatBaseAdapter`) that handles:
- Thread ID encoding/decoding (`wechat:{type}:{conversationId}:{contextToken}`)
- Message parsing (ilink format → Chat SDK `Message`)
- Format conversion (mdast ↔ plain text)
- AES-128-ECB media encryption/decryption
- CDN upload/download

## Contributing

This project uses [changesets](https://github.com/changesets/changesets) for versioning. When making changes:

1. Run `pnpm changeset` to describe your change and select a semver bump
2. Commit the generated changeset file with your code
3. On merge to `main`, a "Version Package" PR is automatically created
4. Merging that PR publishes to npm

## Reference Documentation

- [Vercel Chat SDK](https://github.com/vercel/chat)
- [WeChat ilink Bot API](docs/reference/wechat-ilink-bot-api.md) (local, gitignored)
- [WeChat Official Dialog API](docs/reference/wechat-official-api.md) (local, gitignored)

## License

MIT
