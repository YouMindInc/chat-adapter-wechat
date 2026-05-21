import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AdapterPostableMessage,
  ChatInstance,
  Message,
  QueueEntry,
  RawMessage,
} from "chat";
import { ConsoleLogger, Message as ChatMessage } from "chat";
import {
  extractCard,
  extractFiles,
  cardToFallbackText,
  NetworkError,
  AuthenticationError,
} from "@chat-adapter/shared";
import { WeChatBaseAdapter } from "../core/base-adapter.js";
import type {
  WeChatAcpAdapterConfig,
  WeChatRawMessage,
  WeChatMediaItem,
} from "../core/types.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TYPING_INTERVAL_MS,
} from "../core/types.js";
import { resolveThreadId } from "../core/utils.js";
import {
  aesEcbEncrypt,
  encodeAesKeyForSend,
  fileMd5,
  generateFileKey,
} from "../core/media.js";
import { IlinkClient } from "./acp-client.js";
import { MessageType, MessageItemType } from "./acp-types.js";
import type {
  AccountData,
  PollState,
  IlinkMessage,
  IlinkMessageItem,
} from "./acp-types.js";

/**
 * Key prefix for the WeChat-specific durable pending queue. Messages are
 * enqueued here BEFORE the iLink getupdates cursor is advanced, so a crash
 * mid-batch cannot lose messages: state.enqueue is the durability boundary.
 *
 * This is intentionally separate from chat-sdk's per-thread queue (which is
 * scoped to lock-contention concurrency, not crash recovery).
 *
 * In multi-bot gateways the key is suffixed with the adapter's `botId` so
 * instances sharing a single state backend do not cross-drain each other's
 * messages. See {@link WeChatAcpAdapter.pendingQueueKey}.
 */
const PENDING_QUEUE_KEY_PREFIX = "wechat-acp:pending";
/** Cap on the durable pending queue. Trims oldest when exceeded. */
const PENDING_QUEUE_MAX_SIZE = 1000;
/** TTL for entries in the durable pending queue (24h). */
const PENDING_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A QR-login session in progress. Returned by `startQrLogin()` so the
 * caller can deliver the QR image immediately and await — or hand off —
 * the scan result independently.
 */
export interface QrLoginSession {
  /** The QR image to display to the user. */
  qrcode: { imageBase64: string; terminalAscii: string };
  /**
   * Resolves with the persisted `AccountData` when the user scans.
   * Rejects with a `QrLoginError` if iLink expires the code, the
   * server returns an unrecoverable error, or `cancel()` is called.
   *
   * **Crash safety**: this promise has an internal `.catch(() => {})`
   * applied, so callers who don't await it will NOT trigger Node's
   * default unhandled-rejection → SIGTERM behavior. Errors are still
   * logged via the configured logger.
   */
  result: Promise<AccountData>;
  /**
   * Stop polling for the scan result. Causes `result` to reject with
   * a `QrLoginError` carrying `code: "cancelled"`. Idempotent.
   */
  cancel: () => void;
}

/** Error thrown by the `result` promise of a `QrLoginSession`. */
export class QrLoginError extends Error {
  constructor(
    public readonly code: "expired" | "cancelled" | "network",
    message: string
  ) {
    super(message);
    this.name = "QrLoginError";
  }
}

export class WeChatAcpAdapter extends WeChatBaseAdapter {
  /**
   * Adapter name registered with chat-sdk. Includes the caller-supplied
   * `botId` so multiple adapters can coexist in a single Chat without
   * colliding on dedupe/lock keys (which chat-sdk scopes by adapter name).
   */
  readonly name: string;
  /**
   * Caller-supplied bot identifier. Handlers can read this back via
   * `(message.adapter as WeChatAcpAdapter).botId` to route messages to
   * per-bot logic. `undefined` in single-bot deployments.
   */
  readonly botId: string | undefined;
  /**
   * Caller-supplied opaque metadata. The adapter never reads or mutates
   * it — it's exposed unchanged so handlers and callbacks can attach
   * gateway-level context (tenant id, display name, region, etc.) to
   * each instance without maintaining an external Map.
   *
   * Read in handlers via `(message.adapter as WeChatAcpAdapter).metadata`.
   * Cast to your own typed shape if you want stronger typing.
   */
  readonly metadata: Record<string, unknown> | undefined;

  private readonly client: IlinkClient;
  private readonly config: {
    baseUrl: string;
    cdnBaseUrl: string;
    dataDir: string;
    pollIntervalMs: number;
    typingIntervalMs: number;
    onQrCode?: WeChatAcpAdapterConfig["onQrCode"];
    onAuthFailure?: WeChatAcpAdapterConfig["onAuthFailure"];
    accountStorage?: WeChatAcpAdapterConfig["accountStorage"];
    stateStorage?: WeChatAcpAdapterConfig["stateStorage"];
  };

  private pollingActive = false;
  private pollingAbortController: AbortController | null = null;
  private pollingTask: Promise<void> | null = null;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutivePollingFailures = 0;
  private drainPromise: Promise<void> | null = null;
  /**
   * Set by `disconnect()` to interrupt long-running loops promptly. The
   * drainer checks this on every iteration so a `disconnect()` call does
   * not have to wait for an entire backlog of pending messages to flush
   * through `chat.processMessage` before resolving.
   *
   * Distinct from `pollingActive` because the startup drain runs *before*
   * `startPolling()` flips that flag, so we cannot simply gate the
   * drainer on `pollingActive`.
   */
  private isShutdown = false;
  /**
   * Cancellers for in-flight `startQrLogin()` sessions. `disconnect()`
   * walks the set and calls each so a shutdown also tears down any QR
   * scan-worker session that hasn't yet been completed or cancelled by
   * the caller.
   */
  private readonly qrLoginCancellers = new Set<() => void>();
  private pollState: PollState = {
    updatesBuf: "",
    contextTokens: {},
    lastMessageId: 0,
  };

  constructor(config: WeChatAcpAdapterConfig = {}) {
    const name = config.botId ? `wechat-acp:${config.botId}` : "wechat-acp";
    const logger = config.logger ?? new ConsoleLogger("info").child(name);
    super(name, logger);
    this.name = name;
    this.botId = config.botId;
    this.metadata = config.metadata;

    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const cdnBaseUrl = config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
    // Default dataDir is per-bot so parallel adapters don't stomp on each
    // other's account.json / state.json files.
    const defaultDataDir = config.botId
      ? path.join(os.homedir(), ".chat-adapter-wechat", config.botId)
      : path.join(os.homedir(), ".chat-adapter-wechat");
    const dataDir = config.dataDir ?? defaultDataDir;

    this.config = {
      baseUrl,
      cdnBaseUrl,
      dataDir,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      typingIntervalMs: config.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS,
      onQrCode: config.onQrCode,
      onAuthFailure: config.onAuthFailure,
      accountStorage: config.accountStorage,
      stateStorage: config.stateStorage,
    };

    this.client = new IlinkClient({ baseUrl, cdnBaseUrl, logger });
    this.typingIntervalMs = this.config.typingIntervalMs;
  }

  // --- Lifecycle ---

  /**
   * Bring the adapter online.
   *
   * Default behavior (single-process / interactive): if no account is in
   * storage, trigger an in-process QR scan via `loginWithQr` before
   * starting the polling loop.
   *
   * Headless / split-process behavior: pass
   * `{ requireExistingAccount: true }` to refuse the implicit scan and
   * throw if no account is in storage. Use this in polling workers
   * whose credentials were provisioned out of band by `loginWithQr`
   * running in a separate scan worker.
   */
  async initialize(
    chat: ChatInstance,
    options: { requireExistingAccount?: boolean } = {}
  ): Promise<void> {
    this.chat = chat;

    // Try to load saved account
    const account = await this.loadAccount();
    if (account) {
      this.applyAccount(account);
      this.logger.info("Loaded saved WeChat bot account", {
        botId: account.botId,
      });
    } else if (options.requireExistingAccount) {
      throw new Error(
        `WeChatAcpAdapter${
          this.botId ? `[${this.botId}]` : ""
        }: requireExistingAccount is set but no AccountData was found in ` +
          `accountStorage. Run loginWithQr() in your scan worker first.`
      );
    } else {
      // QR code login (interactive / single-process)
      await this.loginWithQr();
    }

    // Load poll state
    this.pollState = await this.loadPollState();

    // Drain any messages persisted by a prior instance that crashed before
    // their handlers could run. Fire-and-forget — runs alongside polling.
    this.scheduleDrain();

    // Start polling
    await this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting adapter", { botId: this.botId });
    this.isShutdown = true;
    this.pollingActive = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.pollingAbortController?.abort();
    // Cancel any in-flight QR login sessions so a stuck scan worker
    // doesn't keep us in disconnect() until iLink times out the
    // long-poll. Each canceller's `result` promise will reject with a
    // QrLoginError("cancelled") on the next poll iteration.
    for (const cancel of this.qrLoginCancellers) {
      try {
        cancel();
      } catch {
        // best-effort
      }
    }
    this.qrLoginCancellers.clear();
    if (this.pollingTask) {
      await this.pollingTask.catch(() => {});
    }
    this.pollingAbortController = null;
    this.pollingTask = null;
    if (this.drainPromise) {
      await this.drainPromise.catch(() => {});
    }
    await this.savePollState();
  }

  // --- QR Login ---

  /**
   * Begin a QR-login session. Fetches a fresh QR code from iLink,
   * returns immediately with the image and a deferred result, and
   * starts polling for the scan in the background.
   *
   * The caller decides when (or whether) to await the result —
   * scan-worker HTTP handlers can return the QR image to the frontend
   * right away while the actual scan happens minutes later. There is
   * no wall-clock deadline imposed by the adapter: the polling loop
   * runs until iLink reports `"expired"`, the user calls `cancel()`,
   * or the scan succeeds. If you need a wall-clock bound, race
   * `result` against your own timer and call `cancel()` from the
   * loser.
   *
   * **No SIGTERM risk.** The internal result promise has its own
   * `.catch(() => {})` attached, so a caller that ignores `result`
   * will not crash the Node process via unhandled-rejection. Errors
   * are still logged via the configured logger.
   *
   * No `Chat` instance is required — safe to call from a dedicated
   * scan worker.
   */
  async startQrLogin(): Promise<QrLoginSession> {
    this.logger.info("Starting QR code login...");
    const qr = await this.client.fetchQrCode();

    let cancelled = false;
    let resolveResult!: (account: AccountData) => void;
    let rejectResult!: (error: QrLoginError) => void;
    const result = new Promise<AccountData>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Suppress unhandled-rejection if the caller never awaits result.
    // We still log every rejection inside the polling loop so problems
    // are not invisible. This is what makes startQrLogin() safe to fire
    // from a scan-worker HTTP handler that doesn't hold onto `result`.
    result.catch(() => {});

    const cancel = () => {
      cancelled = true;
      this.qrLoginCancellers.delete(cancel);
    };
    this.qrLoginCancellers.add(cancel);

    const pollLoop = async () => {
      try {
        // Outcome is set by exactly one branch below; the post-loop
        // dispatch then resolves/rejects accordingly. This avoids the
        // bug where `return` from inside the loop left the result
        // promise hanging if cancelled fired between iterations.
        let outcome:
          | { kind: "confirmed"; account: AccountData }
          | { kind: "expired" }
          | { kind: "cancelled" }
          | null = null;

        while (!cancelled && outcome === null) {
          const status = await this.client.pollQrStatus(qr.qrcode);
          if (cancelled) {
            outcome = { kind: "cancelled" };
            break;
          }
          if (status.status === "confirmed") {
            const account: AccountData = {
              botToken: status.bot_token!,
              botId: status.ilink_bot_id!,
              userId: status.ilink_user_id!,
              baseUrl: this.config.baseUrl,
              savedAt: Date.now(),
            };
            this.applyAccount(account);
            await this.saveAccount(account);
            this.logger.info("QR login successful", { botId: account.botId });
            outcome = { kind: "confirmed", account };
            break;
          }
          if (status.status === "expired") {
            this.logger.warn("QR login expired", { botId: this.botId });
            outcome = { kind: "expired" };
            break;
          }
        }
        // If the loop exited via `while (!cancelled)` without setting
        // outcome (i.e. cancelled became true between iterations), still
        // dispatch a cancellation result.
        if (outcome === null) {
          outcome = { kind: "cancelled" };
        }

        if (outcome.kind === "confirmed") {
          resolveResult(outcome.account);
        } else if (outcome.kind === "expired") {
          rejectResult(
            new QrLoginError(
              "expired",
              "QR code expired before it was scanned. " +
                "Call startQrLogin() again to issue a new code."
            )
          );
        } else {
          rejectResult(
            new QrLoginError("cancelled", "QR login session was cancelled")
          );
        }
      } catch (error) {
        this.logger.error("QR login polling error", {
          error,
          botId: this.botId,
        });
        rejectResult(
          new QrLoginError(
            "network",
            `QR status poll failed: ${String(error)}`
          )
        );
      } finally {
        // Always release the canceller so disconnect() doesn't hold
        // a reference to a finished session.
        this.qrLoginCancellers.delete(cancel);
      }
    };
    // Fire-and-forget. pollLoop has its own internal try/catch, and the
    // result promise has its own .catch(noop) above, so nothing here can
    // escape into an unhandled rejection.
    void pollLoop();

    return {
      qrcode: {
        imageBase64: qr.qrcode_img_content,
        terminalAscii: "",
      },
      result,
      cancel,
    };
  }

  /**
   * Convenience wrapper around `startQrLogin()` for interactive /
   * single-process flows: fetches the QR code, fires the configured
   * `onQrCode` callback, and awaits the scan result inline.
   *
   * Resolves with the persisted `AccountData`, or rejects with a
   * `QrLoginError` if iLink expires the code or the network fails.
   * For headless / split-process gateways that need to deliver the
   * QR image to a remote frontend, use `startQrLogin()` directly so
   * the HTTP handler can return without holding the connection open
   * for the entire scan window.
   */
  async loginWithQr(): Promise<AccountData> {
    const session = await this.startQrLogin();
    if (this.config.onQrCode) {
      this.config.onQrCode(session.qrcode, {
        botId: this.botId,
        metadata: this.metadata,
      });
    } else {
      this.logger.info(
        "Scan QR code to login (base64 image available in onQrCode callback)"
      );
    }
    return session.result;
  }

  /** Apply credentials from an `AccountData` to the live client + bot identity. */
  private applyAccount(account: AccountData): void {
    this.client.setToken(account.botToken);
    this.setBotUserId(account.botId);
    this.setUserName(account.botId);
  }

  // --- Polling ---

  private async startPolling(): Promise<void> {
    if (this.pollingActive) return;
    this.pollingActive = true;
    this.pollingAbortController = new AbortController();
    this.consecutivePollingFailures = 0;
    this.logger.info("Polling started", {
      botId: this.botId,
      pollIntervalMs: this.config.pollIntervalMs,
    });
    this.scheduleNextPoll(0);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.pollingActive) return;
    if (this.pollingTimer) clearTimeout(this.pollingTimer);
    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = null;
      this.runPollAttempt();
    }, Math.max(0, delayMs));
  }

  private runPollAttempt(): void {
    if (!this.pollingActive || this.pollingTask) return;

    const task = this.pollOnce().finally(() => {
      if (this.pollingTask === task) {
        this.pollingTask = null;
      }
    });
    this.pollingTask = task;
    void task;
  }

  private async pollOnce(): Promise<void> {
    const pollStartedAt = Date.now();
    try {
      const response = await this.client.getUpdates(
        this.pollState.updatesBuf,
        this.pollingAbortController?.signal
      );
      const messages = response.msgs ?? [];
      const hasMessages = messages.length > 0;
      if (hasMessages) {
        this.logger.info("Poll received messages", {
          botId: this.botId,
          count: messages.length,
        });
      }

      await this.handlePollResponse(response);

      this.consecutivePollingFailures = 0;
      if (this.pollingActive) {
        const elapsedMs = Date.now() - pollStartedAt;
        this.scheduleNextPoll(
          hasMessages
            ? 0
            : Math.max(0, this.config.pollIntervalMs - elapsedMs)
        );
      }
    } catch (error) {
      if (!this.pollingActive) return;

      // On auth failure, prefer the caller's onAuthFailure hook (for
      // headless workers that need to hand off to a separate scan
      // process). Fall back to the legacy in-process re-login when no
      // hook is configured, to preserve interactive single-process
      // deployments.
      if (error instanceof AuthenticationError) {
        if (this.config.onAuthFailure) {
          this.logger.warn(
            "Auth token invalid; invoking onAuthFailure and stopping polling",
            { botId: this.botId }
          );
          try {
            await this.config.onAuthFailure({
              botId: this.botId,
              metadata: this.metadata,
            });
          } catch (hookError) {
            this.logger.error("onAuthFailure callback threw", {
              error: hookError,
            });
          }
          this.pollingActive = false;
          return;
        }
        this.logger.warn("Auth token invalid, attempting re-login...");
        try {
          await this.loginWithQr();
          this.consecutivePollingFailures = 0;
          this.scheduleNextPoll(0);
          return;
        } catch (reLoginError) {
          this.logger.error("Re-login failed", {
            error: reLoginError,
          });
        }
      }

      this.consecutivePollingFailures++;
      const backoffMs = Math.min(
        1000 * 2 ** this.consecutivePollingFailures,
        60_000
      );
      this.logger.warn(`Polling error (retry in ${backoffMs}ms)`, {
        error,
        failures: this.consecutivePollingFailures,
      });
      this.scheduleNextPoll(backoffMs);
    }
  }

  /**
   * Process the result of a single getupdates poll.
   *
   * Crash-resilience guarantee: messages are durably persisted to the
   * chat-sdk state queue BEFORE the iLink cursor is advanced. iLink does
   * not redeliver messages once the cursor moves, so any code path that
   * advances `pollState.updatesBuf` before persisting is unsafe — a crash
   * between getupdates returning and dispatch finishing would silently
   * drop the message.
   *
   * Ordering:
   *  1. Persist every message in the batch to the durable pending queue.
   *  2. Advance the cursor and save poll state.
   *  3. Trigger the (background) drainer which dispatches handlers via
   *     `chat.processMessage`. Chat-sdk's built-in dedupe handles the case
   *     where step 1 succeeded but a crash before step 2 caused this batch
   *     to be re-fetched on a fresh instance.
   */
  protected async handlePollResponse(response: {
    msgs?: IlinkMessage[];
    get_updates_buf?: string;
  }): Promise<void> {
    if (response.msgs?.length) {
      for (const msg of response.msgs) {
        await this.persistIncomingMessage(msg);
      }
    }

    // Advance cursor only after every message in the batch is durable.
    if (response.get_updates_buf) {
      this.pollState.updatesBuf = response.get_updates_buf;
    }
    if (response.msgs?.length || response.get_updates_buf) {
      await this.savePollState();
    }

    // Kick the background drainer (no-op if one is already running).
    if (response.msgs?.length) {
      this.scheduleDrain();
    }
  }

  /**
   * Convert an iLink message to a chat-sdk Message and append it to the
   * durable pending queue. Skips bot-authored messages.
   *
   * Two layers of dedup operate here:
   *
   *  1. **Within-instance** — `pollState.lastMessageId` skips messages
   *     this instance has already enqueued in the current process. Cheap,
   *     prevents queue pollution if iLink ever delivers the same id in two
   *     overlapping batches without an intervening cursor advance.
   *
   *  2. **Across instances (crash recovery)** — chat-sdk's per-message
   *     dedupe at dispatch time (`dedupe:${adapter.name}:${id}`). After a
   *     crash before cursor save, the next instance re-fetches the same
   *     batch — `lastMessageId` was loaded from stale storage and won't
   *     help, so we re-enqueue and rely on chat-sdk to drop the duplicate
   *     when the drainer dispatches it. This layer is the load-bearing
   *     one for correctness.
   */
  protected async persistIncomingMessage(msg: IlinkMessage): Promise<void> {
    if (msg.message_type === MessageType.BOT) return;
    if (msg.message_id == null) return;
    if (!this.chat) return;

    // Within-instance dedup: skip ids we've already enqueued in this
    // process. This is a best-effort fast path; correctness still relies
    // on chat-sdk's dispatch-time dedupe for the cross-instance case.
    if (msg.message_id <= this.pollState.lastMessageId) return;

    // Track context token keyed by conversation (group or DM). This is
    // in-memory only and best-effort; recreation on a fresh instance is OK
    // because subsequent messages carry their own context_token.
    const conversationKey = msg.group_id || msg.from_user_id;
    if (conversationKey && msg.context_token) {
      this.pollState.contextTokens[conversationKey] = msg.context_token;
    }
    this.pollState.lastMessageId = msg.message_id;

    const rawMessage = this.ilinkToRawMessage(msg);
    const message = this.parseMessage(rawMessage);

    const state = this.chat.getState();
    const now = Date.now();
    const entry: QueueEntry = {
      message,
      enqueuedAt: now,
      expiresAt: now + PENDING_QUEUE_TTL_MS,
    };
    await state.enqueue(this.pendingQueueKey, entry, PENDING_QUEUE_MAX_SIZE);
    this.logger.info("Message enqueued to pending queue", {
      messageId: msg.message_id,
      fromUserId: msg.from_user_id,
    });
  }

  /**
   * Start the background drainer if it's not already running. Safe to call
   * concurrently — only one drain loop runs at a time.
   */
  protected scheduleDrain(): void {
    if (this.drainPromise) return;
    if (!this.chat) return;
    this.drainPromise = this.drainPendingQueue().finally(() => {
      this.drainPromise = null;
    });
  }

  /**
   * Drain the durable pending queue, dispatching each message via
   * `chat.processMessage`. Chat-sdk dedupes by message id, so re-fetched
   * messages from a previous crashed batch are skipped automatically.
   *
   * Stops draining when:
   *  - the queue is empty, or
   *  - `disconnect()` has flipped `isShutdown` (so a backlog of thousands
   *    of messages can't block `disconnect()` from returning promptly).
   */
  protected async drainPendingQueue(): Promise<void> {
    if (!this.chat) return;
    const state = this.chat.getState();
    let dispatched = 0;
    while (!this.isShutdown) {
      const entry = await state.dequeue(this.pendingQueueKey);
      if (!entry) {
        if (dispatched > 0) {
          this.logger.info("Pending queue drained", { dispatched });
        }
        return;
      }
      if (Date.now() > entry.expiresAt) {
        this.logger.warn("Skipping expired pending message", {
          messageId: entry.message?.id,
          enqueuedAt: entry.enqueuedAt,
          expiresAt: entry.expiresAt,
        });
        continue;
      }

      // After a JSON roundtrip via the state adapter, entry.message is a
      // plain object. Rehydrate it back into a Message instance so chat-sdk
      // can use class methods like detectMention.
      const message = this.rehydrateMessage(entry.message);
      this.chat.processMessage(this, message.threadId, message);
      dispatched++;
    }
  }

  /**
   * State-key partition for this adapter's durable pending queue. Includes
   * the bot id so multiple adapters sharing one state backend never
   * cross-drain each other's messages.
   */
  protected get pendingQueueKey(): string {
    return this.botId
      ? `${PENDING_QUEUE_KEY_PREFIX}:${this.botId}`
      : PENDING_QUEUE_KEY_PREFIX;
  }

  private rehydrateMessage(raw: Message): Message {
    if (raw instanceof ChatMessage) return raw;
    // After JSON roundtrip the entry stored a plain object, but the
    // QueueEntry type still types it as Message. Cast through unknown
    // because Message.fromJSON expects its own SerializedMessage shape.
    return ChatMessage.fromJSON(raw as unknown as Parameters<typeof ChatMessage.fromJSON>[0]);
  }

  private ilinkToRawMessage(msg: IlinkMessage): WeChatRawMessage {
    let text = "";
    const media: WeChatMediaItem[] = [];

    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        text += item.text_item.text;
      }
      const mediaItem = this.extractMediaItem(item);
      if (mediaItem) media.push(mediaItem);
    }

    // Handle ref_msg
    let refMsg = undefined;
    const refSource = msg.ref_msg ?? msg.item_list?.[0]?.ref_msg;
    if (refSource) {
      refMsg = {
        text: refSource.message_item?.text_item?.text,
        title: refSource.title,
        mediaItem: refSource.message_item
          ? this.extractMediaItem(refSource.message_item)
          : undefined,
      };
    }

    return {
      messageId: msg.message_id ?? 0,
      fromUserId: msg.from_user_id ?? "",
      toUserId: msg.to_user_id ?? "",
      groupId: msg.group_id || undefined,
      text,
      createTime: msg.create_time_ms ?? Date.now(),
      contextToken: msg.context_token,
      media,
      refMsg:
        refMsg?.text || refMsg?.title || refMsg?.mediaItem
          ? refMsg
          : undefined,
      raw: msg,
    };
  }

  private extractMediaItem(
    item: IlinkMessageItem
  ): WeChatMediaItem | undefined {
    if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
      const m = item.image_item.media;
      const aesKey = m.aes_key ?? item.image_item.aeskey ?? "";
      if (m.encrypt_query_param && aesKey) {
        return {
          kind: "image",
          encryptQueryParam: m.encrypt_query_param,
          aesKey,
          size: item.image_item.mid_size,
        };
      }
    }
    if (item.type === MessageItemType.FILE && item.file_item?.media) {
      const m = item.file_item.media;
      if (m.encrypt_query_param && m.aes_key) {
        return {
          kind: "file",
          encryptQueryParam: m.encrypt_query_param,
          aesKey: m.aes_key,
          fileName: item.file_item.file_name,
        };
      }
    }
    if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
      const m = item.video_item.media;
      if (m.encrypt_query_param && m.aes_key) {
        return {
          kind: "video",
          encryptQueryParam: m.encrypt_query_param,
          aesKey: m.aes_key,
          size: item.video_item.video_size,
        };
      }
    }
    return undefined;
  }

  // --- Sending ---

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WeChatRawMessage>> {
    const decoded = resolveThreadId(threadId);
    const { conversationId, contextToken } = decoded;
    const ctx =
      contextToken ?? this.pollState.contextTokens[conversationId] ?? "";

    // Extract text content
    const card = extractCard(message);
    const text = card
      ? cardToFallbackText(card)
      : this.formatConverter.renderPostable(message);

    // Extract and upload image attachments
    const files = extractFiles(message);
    const imageUploads: Array<{
      encryptQueryParam: string;
      aesKeyB64: string;
      ciphertextSize: number;
    }> = [];

    for (const file of files) {
      const isImage =
        file.mimeType?.startsWith("image/") ||
        file.filename?.match(/\.(jpg|jpeg|png|gif|webp)$/i);
      if (isImage) {
        const buf = Buffer.isBuffer(file.data)
          ? file.data
          : Buffer.from(
              file.data instanceof ArrayBuffer
                ? file.data
                : await new Response(file.data as Blob).arrayBuffer()
            );
        const uploaded = await this.uploadImage(conversationId, buf);
        imageUploads.push(uploaded);
      }
    }

    // Send message — conversationId is userId for DMs, groupId for groups
    this.logger.info("Sending message", {
      toUserId: conversationId,
      hasText: Boolean(text),
      imageCount: imageUploads.length,
    });
    await this.client.sendMessage({
      toUserId: conversationId,
      text: text || undefined,
      contextToken: ctx,
      images: imageUploads.length > 0 ? imageUploads : undefined,
    });

    const messageId = Date.now();
    const rawMessage: WeChatRawMessage = {
      messageId,
      fromUserId: this.botUserId ?? "",
      toUserId: conversationId,
      groupId: decoded.type === "group" ? conversationId : undefined,
      text,
      createTime: Date.now(),
      contextToken: ctx,
      media: [],
      raw: {},
    };

    return {
      id: String(messageId),
      threadId,
      raw: rawMessage,
    };
  }

  // --- Typing ---

  override async startTyping(threadId: string): Promise<void> {
    try {
      const { conversationId } = resolveThreadId(threadId);
      const ctx = this.pollState.contextTokens[conversationId];
      if (!ctx) return;

      const config = await this.client.getConfig(conversationId, ctx);
      if (config.typing_ticket) {
        await this.client.sendTyping(conversationId, config.typing_ticket, 1);
      }
    } catch (error) {
      // Typing is best-effort; log so transient issues are diagnosable
      this.logger.warn("Typing indicator failed", { error });
    }
  }

  override async stopTyping(threadId: string): Promise<void> {
    try {
      const { conversationId } = resolveThreadId(threadId);
      const ctx = this.pollState.contextTokens[conversationId];
      if (!ctx) return;

      const config = await this.client.getConfig(conversationId, ctx);
      if (config.typing_ticket) {
        await this.client.sendTyping(conversationId, config.typing_ticket, 0);
      }
    } catch (error) {
      this.logger.warn("Stop typing indicator failed", { error });
    }
  }

  // --- Media CDN ---

  protected async downloadFromCdn(encryptQueryParam: string): Promise<Buffer> {
    return this.client.downloadFromCdn(encryptQueryParam);
  }

  private static readonly UPLOAD_MAX_RETRIES = 3;

  async uploadImage(
    toUserId: string,
    imageData: Buffer
  ): Promise<{
    encryptQueryParam: string;
    aesKeyB64: string;
    ciphertextSize: number;
  }> {
    this.logger.info("Uploading image to CDN", {
      toUserId,
      rawSize: imageData.length,
    });
    const aesKey = crypto.randomBytes(16);
    const aesKeyHex = aesKey.toString("hex");
    const rawSize = imageData.length;
    const rawMd5 = fileMd5(imageData);
    const encrypted = aesEcbEncrypt(imageData, aesKey);

    let lastError: Error | undefined;
    for (
      let attempt = 1;
      attempt <= WeChatAcpAdapter.UPLOAD_MAX_RETRIES;
      attempt++
    ) {
      const filekey = generateFileKey(); // new filekey per retry
      try {
        const uploadUrlResp = await this.client.getUploadUrl({
          filekey,
          mediaType: 1, // IMAGE
          toUserId,
          rawSize,
          rawFileMd5: rawMd5,
          fileSize: encrypted.length,
          aesKeyHex,
        });

        let cdnUrl: string;
        if (uploadUrlResp.upload_full_url) {
          cdnUrl = uploadUrlResp.upload_full_url;
        } else if (uploadUrlResp.upload_param) {
          cdnUrl = `${this.config.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadUrlResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
        } else {
          throw new NetworkError(
            "wechat-acp",
            "getUploadUrl returned neither upload_full_url nor upload_param"
          );
        }

        const encryptQueryParam = await this.client.uploadToCdn(
          cdnUrl,
          encrypted
        );

        return {
          encryptQueryParam,
          aesKeyB64: encodeAesKeyForSend(aesKey),
          ciphertextSize: encrypted.length,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Abort on 4xx client errors (no point retrying)
        if (lastError.message.includes("client error")) {
          throw lastError;
        }
        if (attempt < WeChatAcpAdapter.UPLOAD_MAX_RETRIES) {
          const backoffMs = 2 ** attempt * 1000;
          this.logger.warn(
            `CDN upload attempt ${attempt} failed, retrying in ${backoffMs}ms`,
            { error }
          );
          await sleep(backoffMs);
        }
      }
    }

    throw lastError ?? new NetworkError("wechat-acp", "CDN upload failed");
  }

  // --- Persistence ---

  private async loadAccount(): Promise<AccountData | null> {
    if (this.config.accountStorage) {
      return this.config.accountStorage.load();
    }
    try {
      const filePath = path.join(this.config.dataDir, "account.json");
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as AccountData;
    } catch (error) {
      this.logger.info("No saved account found on disk", {
        dataDir: this.config.dataDir,
        error,
      });
      return null;
    }
  }

  private async saveAccount(account: AccountData): Promise<void> {
    if (this.config.accountStorage) {
      return this.config.accountStorage.save(account);
    }
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    const filePath = path.join(this.config.dataDir, "account.json");
    fs.writeFileSync(filePath, JSON.stringify(account, null, 2), {
      mode: 0o600,
    });
  }

  private async loadPollState(): Promise<PollState> {
    if (this.config.stateStorage) {
      return (
        (await this.config.stateStorage.load()) ?? {
          updatesBuf: "",
          contextTokens: {},
          lastMessageId: 0,
        }
      );
    }
    try {
      const filePath = path.join(this.config.dataDir, "state.json");
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as PollState;
    } catch (error) {
      this.logger.info("No saved poll state found, starting fresh", {
        dataDir: this.config.dataDir,
        error,
      });
      return { updatesBuf: "", contextTokens: {}, lastMessageId: 0 };
    }
  }

  private async savePollState(): Promise<void> {
    if (this.config.stateStorage) {
      return this.config.stateStorage.save(this.pollState);
    }
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      const filePath = path.join(this.config.dataDir, "state.json");
      fs.writeFileSync(filePath, JSON.stringify(this.pollState, null, 2));
    } catch (error) {
      this.logger.warn("Failed to save poll state to disk", {
        dataDir: this.config.dataDir,
        error,
      });
    }
  }
}

export function createWeChatAcpAdapter(
  config?: WeChatAcpAdapterConfig
): WeChatAcpAdapter {
  return new WeChatAcpAdapter(config);
}
