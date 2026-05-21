import type { Logger } from "chat";

// --- Client Logger ---

/** Minimal logger for HTTP-level diagnostics (no chat-sdk dependency). */
export interface ClientLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// --- Thread ID ---

export interface WeChatThreadId {
  type: "dm" | "group";
  conversationId: string; // userId for DMs, groupId for groups
  contextToken?: string;
}

// --- Raw Message ---

export interface WeChatRawMessage {
  messageId: number;
  fromUserId: string;
  toUserId: string;
  groupId?: string; // present when message is from a group chat
  messageType?: "text" | "image" | "voice" | "file" | "video";
  text: string;
  createTime: number;
  contextToken?: string;
  media: WeChatMediaItem[];
  refMsg?: WeChatRefMessage;
  raw: unknown;
}

export interface WeChatMediaItem {
  kind: "image" | "voice" | "file" | "video";
  encryptQueryParam: string;
  aesKey: string;
  fileName?: string;
  size?: number;
}

export interface WeChatRefMessage {
  text?: string;
  title?: string;
  mediaItem?: WeChatMediaItem;
}

// --- Configuration ---

export interface WeChatStorage<T> {
  load(): Promise<T | null>;
  save(data: T): Promise<void>;
}

export interface WeChatBaseConfig {
  /**
   * Optional caller-supplied identifier for this bot instance.
   *
   * When set:
   *  - The adapter's `name` becomes `wechat-acp:${botId}` so multiple
   *    adapters can coexist in a single `Chat` without colliding on
   *    chat-sdk's per-adapter dedupe and lock keys.
   *  - The durable pending queue key is scoped to this bot, so multi-bot
   *    gateways sharing a single state backend do not cross-drain each
   *    other's messages.
   *  - The default `dataDir` is scoped to a per-bot subdirectory so disk
   *    persistence for multiple bots doesn't collide.
   *  - `onQrCode` is called with `{ botId }` so the gateway can route the
   *    QR image to the right frontend.
   *  - Handlers can read it back from `(message.adapter as WeChatAcpAdapter).botId`.
   *
   * Not to be confused with the iLink-assigned `ilink_bot_id` that lands
   * in `AccountData.botId` after a successful scan — that one identifies
   * the *scanning WeChat account*, not your logical bot.
   */
  botId?: string;
  /**
   * Arbitrary opaque payload attached to this adapter instance. The
   * adapter does not interpret it — it's surfaced unchanged via:
   *
   *  - the `context.metadata` argument of `onQrCode` and `onAuthFailure`
   *  - the public `metadata` field on the adapter (so message handlers
   *    can read it via `(message.adapter as WeChatAcpAdapter).metadata`)
   *
   * Use it to carry whatever per-instance context your gateway needs
   * (tenant id, display name, region, customer reference, etc.) without
   * having to maintain an external Map keyed by adapter name.
   *
   * `botId` is still required if you need state-storage scoping, queue
   * partitioning, or chat-sdk adapter-name uniqueness. Think of `botId`
   * as the *key* and `metadata` as the *value*.
   */
  metadata?: Record<string, unknown>;
  dataDir?: string;
  pollIntervalMs?: number;
  onQrCode?: (
    qr: { imageBase64: string; terminalAscii: string },
    context: { botId?: string; metadata?: Record<string, unknown> }
  ) => void;
  /**
   * Called when the polling loop receives an authentication failure
   * (HTTP 401/403) from iLink, indicating the bot token has expired or
   * been revoked. The callback runs once, then polling stops cleanly.
   *
   * Use this in headless / split-process deployments where the polling
   * worker cannot show a QR code: signal your scan worker (delete the
   * stale `AccountData`, emit an event, page someone) and re-onboard the
   * bot out of band by running `loginWithQr()` from your scan flow.
   *
   * If `onAuthFailure` is NOT set, the polling loop falls back to the
   * legacy behavior of attempting an in-process `loginWithQr()`, which
   * is only useful for foreground / interactive deployments.
   */
  onAuthFailure?: (
    context: { botId?: string; metadata?: Record<string, unknown> }
  ) => Promise<void> | void;
  logger?: Logger;
}

export interface WeChatAcpAdapterConfig extends WeChatBaseConfig {
  baseUrl?: string;
  cdnBaseUrl?: string;
  typingIntervalMs?: number;
  accountStorage?: WeChatStorage<import("../acp/acp-types.js").AccountData>;
  stateStorage?: WeChatStorage<import("../acp/acp-types.js").PollState>;
}

// --- Constants ---

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_POLL_INTERVAL_MS = 25_000;
export const DEFAULT_TYPING_INTERVAL_MS = 15_000;
export const DEFAULT_API_TIMEOUT_MS = 15_000;
export const GETUPDATES_LONG_POLL_TIMEOUT_MS =
  DEFAULT_POLL_INTERVAL_MS + 5_000;
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;
export const CHANNEL_VERSION = "1.0.2";
export const BOT_TYPE = "3";
