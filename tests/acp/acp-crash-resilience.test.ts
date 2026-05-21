/**
 * Crash-resilience tests for the WeChat ACP adapter.
 *
 * Verifies that messages received via long-polling are durably persisted
 * to the chat-sdk state queue BEFORE the iLink getupdates cursor is
 * advanced. iLink does not redeliver messages once the cursor moves, so
 * the adapter must couple cursor advancement to durable persistence — not
 * to handler completion — to survive instance crashes mid-batch.
 */
import { describe, it, expect, vi } from "vitest";
import {
  Message,
  type ChatInstance,
  type Logger,
  type QueueEntry,
  type StateAdapter,
} from "chat";
import { createWeChatAcpAdapter } from "../../src/acp/index.js";
import type { IlinkMessage } from "../../src/acp/acp-types.js";

const PENDING_QUEUE_KEY = "wechat-acp:pending";

/**
 * Minimal in-memory StateAdapter that implements only the methods the
 * adapter exercises (`enqueue`, `dequeue`, `queueDepth`). Everything else
 * throws so accidental usage is loud.
 */
function createInMemoryState(): StateAdapter {
  const queues = new Map<string, QueueEntry[]>();
  const notImplemented = (name: string) => () => {
    throw new Error(`InMemoryState.${name} not implemented for this test`);
  };
  return {
    enqueue: vi.fn(async (key: string, entry: QueueEntry, maxSize: number) => {
      const list = queues.get(key) ?? [];
      list.push(entry);
      while (list.length > maxSize) list.shift();
      queues.set(key, list);
      return list.length;
    }),
    dequeue: vi.fn(async (key: string) => {
      const list = queues.get(key);
      if (!list || list.length === 0) return null;
      return list.shift() ?? null;
    }),
    queueDepth: vi.fn(async (key: string) => queues.get(key)?.length ?? 0),
    acquireLock: notImplemented("acquireLock") as never,
    appendToList: notImplemented("appendToList") as never,
    connect: notImplemented("connect") as never,
    delete: notImplemented("delete") as never,
    disconnect: notImplemented("disconnect") as never,
    extendLock: notImplemented("extendLock") as never,
    forceReleaseLock: notImplemented("forceReleaseLock") as never,
    get: notImplemented("get") as never,
    getList: notImplemented("getList") as never,
    isSubscribed: notImplemented("isSubscribed") as never,
    releaseLock: notImplemented("releaseLock") as never,
    set: notImplemented("set") as never,
    setIfNotExists: notImplemented("setIfNotExists") as never,
    subscribe: notImplemented("subscribe") as never,
    unsubscribe: notImplemented("unsubscribe") as never,
  };
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

function createFakeChat(state: StateAdapter): {
  chat: ChatInstance;
  processMessage: ReturnType<typeof vi.fn>;
} {
  const processMessage = vi.fn();
  const chat: ChatInstance = {
    getLogger: () => silentLogger,
    getState: () => state,
    getUserName: () => "wechat-bot",
    handleIncomingMessage: async () => {},
    processMessage: processMessage as never,
    processAction: () => {},
    processAppHomeOpened: () => {},
    processAssistantContextChanged: () => {},
    processAssistantThreadStarted: () => {},
    processMemberJoinedChannel: () => {},
    processModalClose: () => {},
    processModalSubmit: async () => undefined,
    processReaction: () => {},
    processSlashCommand: () => {},
  };
  return { chat, processMessage };
}

function makeIlinkMessage(id: number, text = `msg${id}`): IlinkMessage {
  return {
    message_id: id,
    from_user_id: `user_${id}`,
    to_user_id: "bot",
    message_type: 1, // USER
    create_time_ms: 1_700_000_000_000 + id,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: `ctx_${id}`,
  };
}

async function setupAdapter(initialBuf = "") {
  const adapter = createWeChatAcpAdapter({ baseUrl: "https://test.example" });
  const state = createInMemoryState();
  const { chat, processMessage } = createFakeChat(state);
  // Inject the chat instance and a starting cursor without going through
  // the QR-login path.
  (adapter as unknown as { chat: ChatInstance }).chat = chat;
  (adapter as unknown as { pollState: { updatesBuf: string } }).pollState = {
    updatesBuf: initialBuf,
    contextTokens: {},
    lastMessageId: 0,
  };
  return { adapter, state, chat, processMessage };
}

describe("ACP crash resilience", () => {
  it("persists every message in a batch BEFORE advancing the cursor", async () => {
    const { adapter, state } = await setupAdapter("cursor_old");

    const batch = [
      makeIlinkMessage(1),
      makeIlinkMessage(2),
      makeIlinkMessage(3),
      makeIlinkMessage(4),
      makeIlinkMessage(5),
    ];

    // Capture queue depth at the moment the cursor is written so we can
    // assert ordering: at write-time, all 5 messages must already be in
    // the durable queue.
    let depthAtCursorAdvance = -1;
    const enqueueSpy = state.enqueue as ReturnType<typeof vi.fn>;
    const originalSavePollState = (
      adapter as unknown as { savePollState: () => Promise<void> }
    ).savePollState.bind(adapter);
    (
      adapter as unknown as { savePollState: () => Promise<void> }
    ).savePollState = async () => {
      depthAtCursorAdvance = enqueueSpy.mock.calls.length;
      return originalSavePollState();
    };

    await (
      adapter as unknown as {
        handlePollResponse: (r: unknown) => Promise<void>;
      }
    ).handlePollResponse({
      msgs: batch,
      get_updates_buf: "cursor_new",
    });

    expect(depthAtCursorAdvance).toBe(5);
    expect(
      (adapter as unknown as { pollState: { updatesBuf: string } }).pollState
        .updatesBuf
    ).toBe("cursor_new");
  });

  it("a handler that throws does not affect persistence or cursor", async () => {
    const { adapter, state, processMessage } = await setupAdapter("cursor_old");

    // Simulate the dispatcher's handler failing on m2. Real
    // chat.processMessage spawns the handler as an internal async task and
    // catches errors with logger.error, so the synchronous adapter caller
    // never sees a throw. We model that here with a swallowed rejection.
    processMessage.mockImplementation((_a, _t, _m) => {
      const msg = _m as Message;
      if (msg.id === "2") {
        Promise.reject(new Error("handler boom")).catch(() => {});
      }
    });

    const batch = [1, 2, 3, 4, 5].map((i) => makeIlinkMessage(i));
    const promise = (
      adapter as unknown as {
        handlePollResponse: (r: unknown) => Promise<void>;
      }
    ).handlePollResponse({ msgs: batch, get_updates_buf: "cursor_new" });

    // The throw must not propagate out of handlePollResponse.
    await expect(promise).resolves.toBeUndefined();

    // All 5 messages were enqueued before any handler ran.
    const enqueueSpy = state.enqueue as ReturnType<typeof vi.fn>;
    expect(enqueueSpy).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      const [key, entry] = enqueueSpy.mock.calls[i]!;
      expect(key).toBe(PENDING_QUEUE_KEY);
      expect((entry as QueueEntry).message.id).toBe(String(i + 1));
    }

    // Cursor was advanced exactly once, after persistence.
    expect(
      (adapter as unknown as { pollState: { updatesBuf: string } }).pollState
        .updatesBuf
    ).toBe("cursor_new");
  });

  it("crash between persistence and dispatch: another instance can drain the surviving queue", async () => {
    // Instance A persists a batch, advances the cursor, then is killed
    // before its drainer ever gets a chance to run. We stub scheduleDrain
    // BEFORE handlePollResponse so the auto-drain never starts.
    const { adapter: instanceA, state } = await setupAdapter("cursor_old");
    (instanceA as unknown as { scheduleDrain: () => void }).scheduleDrain =
      () => {};
    const batch = [1, 2, 3].map((i) => makeIlinkMessage(i));
    await (
      instanceA as unknown as {
        handlePollResponse: (r: unknown) => Promise<void>;
      }
    ).handlePollResponse({ msgs: batch, get_updates_buf: "cursor_new" });

    // The 3 messages must still be in the durable pending queue and the
    // cursor on disk reflects "cursor_new".
    const remaining = await state.queueDepth(PENDING_QUEUE_KEY);
    expect(remaining).toBe(3);

    // Instance B comes up and shares the same state. Its drainer pops
    // every surviving message and dispatches via chat.processMessage.
    const instanceB = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
    });
    const { chat: chatB, processMessage: processMessageB } =
      createFakeChat(state);
    (instanceB as unknown as { chat: ChatInstance }).chat = chatB;

    await (
      instanceB as unknown as { drainPendingQueue: () => Promise<void> }
    ).drainPendingQueue();

    expect(processMessageB).toHaveBeenCalledTimes(3);
    const dispatchedIds = processMessageB.mock.calls
      .map((c) => (c[2] as Message).id)
      .sort();
    expect(dispatchedIds).toEqual(["1", "2", "3"]);
    expect(await state.queueDepth(PENDING_QUEUE_KEY)).toBe(0);
  });

  it("crash before cursor advance: the same batch is re-fetched and re-persisted; chat-sdk dedupe handles dispatch duplication", async () => {
    // Shared state survives the crash.
    const state = createInMemoryState();

    // Instance A receives the batch, persists everything, then is killed
    // BEFORE savePollState. The cursor on the iLink side never advanced,
    // so a fresh poll returns the same batch.
    const { adapter: instanceA } = await setupAdapter("cursor_old");
    const { chat: chatA } = createFakeChat(state);
    (instanceA as unknown as { chat: ChatInstance }).chat = chatA;
    (instanceA as unknown as { scheduleDrain: () => void }).scheduleDrain =
      () => {};
    const batch = [1, 2, 3].map((i) => makeIlinkMessage(i));

    // Persist only — skip cursor advance to simulate the crash.
    for (const m of batch) {
      await (
        instanceA as unknown as {
          persistIncomingMessage: (m: IlinkMessage) => Promise<void>;
        }
      ).persistIncomingMessage(m);
    }

    expect(await state.queueDepth(PENDING_QUEUE_KEY)).toBe(3);

    // Instance B starts, sees the un-advanced cursor, and the iLink server
    // re-delivers the same batch (because cursor never moved). It persists
    // again — chat-sdk's dedupe at dispatch time will reject the duplicates.
    const instanceB = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
    });
    const { chat: chatB, processMessage: processMessageB } =
      createFakeChat(state);
    (instanceB as unknown as { chat: ChatInstance }).chat = chatB;
    (instanceB as unknown as { pollState: object }).pollState = {
      updatesBuf: "cursor_old",
      contextTokens: {},
      lastMessageId: 0,
    };

    await (
      instanceB as unknown as {
        handlePollResponse: (r: unknown) => Promise<void>;
      }
    ).handlePollResponse({ msgs: batch, get_updates_buf: "cursor_new" });

    // Cursor advances on instance B.
    expect(
      (instanceB as unknown as { pollState: { updatesBuf: string } }).pollState
        .updatesBuf
    ).toBe("cursor_new");

    // Drain to flush whatever is in the queue.
    await (
      instanceB as unknown as { drainPendingQueue: () => Promise<void> }
    ).drainPendingQueue();

    // Six entries were dispatched in total (3 from A's persist + 3 from
    // B's re-persist). chat-sdk's dedupe — verified separately in chat-sdk
    // tests — would reject the second copy of each id at handleIncomingMessage
    // time. Here we just assert the adapter handed everything off and the
    // queue is empty (no message lost).
    expect(processMessageB).toHaveBeenCalledTimes(6);
    expect(await state.queueDepth(PENDING_QUEUE_KEY)).toBe(0);
    const dispatchedIds = processMessageB.mock.calls
      .map((c) => (c[2] as Message).id)
      .sort();
    expect(dispatchedIds).toEqual(["1", "1", "2", "2", "3", "3"]);
  });

  it("scopes name, pending queue key, and dedupe per botId", async () => {
    // Two adapters, same shared state backend, different botIds. A message
    // persisted by one must not be visible in the other's pending queue.
    const state = createInMemoryState();

    const adapterA = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "sales",
    });
    const adapterB = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "support",
    });
    const { chat: chatA } = createFakeChat(state);
    const { chat: chatB, processMessage: processMessageB } =
      createFakeChat(state);
    (adapterA as unknown as { chat: ChatInstance }).chat = chatA;
    (adapterB as unknown as { chat: ChatInstance }).chat = chatB;
    (adapterA as unknown as { scheduleDrain: () => void }).scheduleDrain =
      () => {};
    (adapterB as unknown as { scheduleDrain: () => void }).scheduleDrain =
      () => {};

    // Adapter name must include the botId so chat-sdk's per-adapter
    // dedupe and lock keys don't collide.
    expect(adapterA.name).toBe("wechat-acp:sales");
    expect(adapterB.name).toBe("wechat-acp:support");
    expect(adapterA.botId).toBe("sales");
    expect(adapterB.botId).toBe("support");

    // Pre-seed the pollState on both so persistIncomingMessage runs.
    (adapterA as unknown as { pollState: object }).pollState = {
      updatesBuf: "",
      contextTokens: {},
      lastMessageId: 0,
    };
    (adapterB as unknown as { pollState: object }).pollState = {
      updatesBuf: "",
      contextTokens: {},
      lastMessageId: 0,
    };

    // Adapter A persists two messages; adapter B persists none.
    for (const m of [makeIlinkMessage(10), makeIlinkMessage(11)]) {
      await (
        adapterA as unknown as {
          persistIncomingMessage: (m: IlinkMessage) => Promise<void>;
        }
      ).persistIncomingMessage(m);
    }

    expect(await state.queueDepth("wechat-acp:pending:sales")).toBe(2);
    expect(await state.queueDepth("wechat-acp:pending:support")).toBe(0);

    // Adapter B's drainer must not see adapter A's messages.
    await (
      adapterB as unknown as { drainPendingQueue: () => Promise<void> }
    ).drainPendingQueue();
    expect(processMessageB).not.toHaveBeenCalled();
    expect(await state.queueDepth("wechat-acp:pending:sales")).toBe(2);
  });

  it("passes botId to the onQrCode callback context", async () => {
    // We don't fetch real QR codes in tests, but we can still verify the
    // adapter threads botId into the callback by stubbing the client.
    const onQrCode = vi.fn();
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "ops",
      onQrCode,
    });

    // Stub the iLink client to return a fake QR code, then stub
    // pollQrStatus so qrLogin exits via the "confirmed" branch on the
    // first poll.
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: async () => ({
        status: "confirmed",
        bot_token: "tok",
        ilink_bot_id: "ilink-1",
        ilink_user_id: "user-1",
      }),
      setToken: () => {},
    };
    // Skip the account save to /tmp during the test.
    (
      adapter as unknown as { saveAccount: () => Promise<void> }
    ).saveAccount = async () => {};

    await adapter.loginWithQr();

    expect(onQrCode).toHaveBeenCalledTimes(1);
    const [qr, ctx] = onQrCode.mock.calls[0]!;
    expect(qr).toMatchObject({ imageBase64: "base64-png" });
    expect(ctx).toEqual({ botId: "ops" });
  });

  it("loginWithQr persists AccountData via accountStorage and returns it", async () => {
    // Scan-side workflow: a separate process / handler runs only the
    // scan flow and writes AccountData into shared storage. The polling
    // worker reads it back later.
    let saved: unknown = null;
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "scan-only",
      accountStorage: {
        load: async () => null,
        save: async (data) => {
          saved = data;
        },
      },
    });
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: async () => ({
        status: "confirmed",
        bot_token: "tok-123",
        ilink_bot_id: "ilink-bot-id-1",
        ilink_user_id: "ilink-user-id-1",
      }),
      setToken: () => {},
    };

    const result = await adapter.loginWithQr();

    expect(result).toMatchObject({
      botToken: "tok-123",
      botId: "ilink-bot-id-1",
      userId: "ilink-user-id-1",
    });
    expect(saved).toEqual(result);
  });

  it("initialize({ requireExistingAccount: true }) throws instead of scanning", async () => {
    // Headless polling worker startup with no provisioned account: must
    // fail loudly so the operator knows to run loginWithQr first.
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "polling-only",
      accountStorage: {
        load: async () => null,
        save: async () => {},
      },
    });
    // Spy on loginWithQr to confirm it's NOT called.
    const loginSpy = vi.fn();
    (adapter as unknown as { loginWithQr: typeof loginSpy }).loginWithQr =
      loginSpy;

    const state = createInMemoryState();
    const { chat } = createFakeChat(state);

    await expect(
      adapter.initialize(chat, { requireExistingAccount: true })
    ).rejects.toThrow(/no AccountData was found/);
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it("initialize({ requireExistingAccount: true }) succeeds when an account is in storage", async () => {
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "polling-only",
      accountStorage: {
        load: async () => ({
          botToken: "tok",
          botId: "ilink-bot",
          userId: "ilink-user",
          baseUrl: "https://test.example",
          savedAt: 0,
        }),
        save: async () => {},
      },
      stateStorage: {
        load: async () => ({
          updatesBuf: "saved-cursor",
          contextTokens: { conv1: "ctx-conv1" },
          lastMessageId: 99,
        }),
        save: async () => {},
      },
    });
    // Stub startPolling so the test doesn't open a real long-poll loop.
    (adapter as unknown as { startPolling: () => Promise<void> }).startPolling =
      async () => {};

    const state = createInMemoryState();
    const { chat } = createFakeChat(state);
    await adapter.initialize(chat, { requireExistingAccount: true });

    // PollState was loaded from stateStorage.
    const pollState = (adapter as unknown as {
      pollState: { updatesBuf: string; lastMessageId: number };
    }).pollState;
    expect(pollState.updatesBuf).toBe("saved-cursor");
    expect(pollState.lastMessageId).toBe(99);
  });

  it("onAuthFailure runs once on 401 and then polling stops cleanly (no in-process re-scan)", async () => {
    const onAuthFailure = vi.fn();
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "headless",
      onAuthFailure,
    });

    // Stub the client so the very first getUpdates throws AuthenticationError.
    const { AuthenticationError } = await import("@chat-adapter/shared");
    (adapter as unknown as { client: unknown }).client = {
      getUpdates: vi.fn().mockRejectedValue(
        new AuthenticationError("wechat-acp", "token expired")
      ),
      setToken: () => {},
    };
    // loginWithQr must NOT be called when onAuthFailure is set.
    const loginSpy = vi.fn();
    (adapter as unknown as { loginWithQr: typeof loginSpy }).loginWithQr =
      loginSpy;

    // Drive one polling attempt directly: mark active, give it an abort
    // controller and a fake chat.
    (adapter as unknown as { pollingActive: boolean }).pollingActive = true;
    (adapter as unknown as {
      pollingAbortController: AbortController | null;
    }).pollingAbortController = new AbortController();
    const state = createInMemoryState();
    const { chat } = createFakeChat(state);
    (adapter as unknown as { chat: ChatInstance }).chat = chat;

    await (adapter as unknown as {
      pollOnce: () => Promise<void>;
    }).pollOnce();

    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledWith({ botId: "headless" });
    expect(loginSpy).not.toHaveBeenCalled();
    expect(
      (adapter as unknown as { pollingActive: boolean }).pollingActive
    ).toBe(false);
  });

  it("uses pollIntervalMs only to throttle empty getupdates polls", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createWeChatAcpAdapter({
        baseUrl: "https://test.example",
        pollIntervalMs: 1000,
        stateStorage: {
          load: async () => null,
          save: async () => {},
        },
      });
      const state = createInMemoryState();
      const { chat } = createFakeChat(state);

      (adapter as unknown as { chat: ChatInstance }).chat = chat;
      (adapter as unknown as {
        pollState: {
          updatesBuf: string;
          contextTokens: Record<string, string>;
          lastMessageId: number;
        };
      }).pollState = {
        updatesBuf: "",
        contextTokens: {},
        lastMessageId: 0,
      };
      (adapter as unknown as { pollingActive: boolean }).pollingActive = true;
      (adapter as unknown as {
        pollingAbortController: AbortController | null;
      }).pollingAbortController = new AbortController();
      (adapter as unknown as {
        handlePollResponse: (response: unknown) => Promise<void>;
      }).handlePollResponse = vi.fn(async () => {});

      const getUpdates = vi
        .fn()
        .mockResolvedValueOnce({
          ret: 0,
          msgs: [makeIlinkMessage(1)],
          get_updates_buf: "cursor_1",
        })
        .mockResolvedValueOnce({ ret: 0, msgs: [] })
        .mockImplementationOnce(async () => {
          (adapter as unknown as { pollingActive: boolean }).pollingActive =
            false;
          return { ret: 0, msgs: [] };
        });
      (adapter as unknown as { client: unknown }).client = {
        getUpdates,
        setToken: () => {},
      };

      await (adapter as unknown as {
        pollOnce: () => Promise<void>;
      }).pollOnce();

      expect(getUpdates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(0);
      expect(getUpdates).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(999);
      expect(getUpdates).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);

      expect(getUpdates).toHaveBeenCalledTimes(3);
      expect(typeof getUpdates.mock.calls[0]![1]).not.toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces caller-supplied metadata on the adapter and in callback contexts", async () => {
    type SalesMeta = { tenantId: string; displayName: string };
    const metadata: SalesMeta = {
      tenantId: "tenant_42",
      displayName: "Sales Bot",
    };

    const onQrCode = vi.fn();
    const onAuthFailure = vi.fn();
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "sales",
      metadata,
      onQrCode,
      onAuthFailure,
    });

    // Public field is set on the adapter, so handlers can read it back.
    expect(adapter.metadata).toEqual(metadata);
    expect((adapter.metadata as SalesMeta).tenantId).toBe("tenant_42");

    // onQrCode receives metadata in its context arg.
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr",
        qrcode_img_content: "png",
      }),
      pollQrStatus: async () => ({
        status: "confirmed",
        bot_token: "tok",
        ilink_bot_id: "ilink-bot",
        ilink_user_id: "ilink-user",
      }),
      setToken: () => {},
    };
    (
      adapter as unknown as { saveAccount: () => Promise<void> }
    ).saveAccount = async () => {};
    await adapter.loginWithQr();
    expect(onQrCode).toHaveBeenCalledTimes(1);
    expect(onQrCode.mock.calls[0]![1]).toEqual({
      botId: "sales",
      metadata,
    });

    // onAuthFailure receives metadata in its context arg.
    const { AuthenticationError } = await import("@chat-adapter/shared");
    (adapter as unknown as { client: unknown }).client = {
      getUpdates: vi.fn().mockRejectedValue(
        new AuthenticationError("wechat-acp", "expired")
      ),
      setToken: () => {},
    };
    (adapter as unknown as { pollingActive: boolean }).pollingActive = true;
    (adapter as unknown as {
      pollingAbortController: AbortController | null;
    }).pollingAbortController = new AbortController();
    const state = createInMemoryState();
    const { chat } = createFakeChat(state);
    (adapter as unknown as { chat: ChatInstance }).chat = chat;
    await (adapter as unknown as {
      pollOnce: () => Promise<void>;
    }).pollOnce();
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(onAuthFailure.mock.calls[0]![0]).toEqual({
      botId: "sales",
      metadata,
    });
  });

  it("drainPendingQueue exits promptly when isShutdown flips, even with messages still queued", async () => {
    // Regression test for review feedback: previously the drainer ran
    // until the queue was empty, blocking disconnect() on a large
    // backlog. Now it checks `isShutdown` on every iteration so a
    // disconnect-mid-drain can interrupt promptly.
    const { adapter, state, processMessage } = await setupAdapter();

    // Pre-seed 50 entries in the pending queue.
    for (let i = 1; i <= 50; i++) {
      const liveMessage = adapter.parseMessage({
        messageId: i,
        fromUserId: `u${i}`,
        toUserId: "bot",
        text: `m${i}`,
        createTime: Date.now(),
        media: [],
        raw: {},
      });
      await state.enqueue(
        "wechat-acp:pending",
        {
          message: liveMessage,
          enqueuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
        100
      );
    }

    // Flip isShutdown BEFORE running the drainer — it must exit on the
    // first loop iteration without dispatching anything.
    (adapter as unknown as { isShutdown: boolean }).isShutdown = true;
    await (
      adapter as unknown as { drainPendingQueue: () => Promise<void> }
    ).drainPendingQueue();

    expect(processMessage).not.toHaveBeenCalled();
    // The 50 entries are still in the queue — drain stopped at the top
    // of the loop without consuming any.
    expect(await state.queueDepth("wechat-acp:pending")).toBe(50);
  });

  it("disconnect() sets isShutdown so a long backlog cannot block it", async () => {
    // Verifies the disconnect path itself flips the flag. Pure
    // unit-style: just call disconnect and observe the field.
    const { adapter } = await setupAdapter();
    await adapter.disconnect();
    expect((adapter as unknown as { isShutdown: boolean }).isShutdown).toBe(
      true
    );
  });

  it("persistIncomingMessage skips ids already covered by lastMessageId (within-instance dedup)", async () => {
    const { adapter, state } = await setupAdapter();
    (adapter as unknown as {
      pollState: { lastMessageId: number; updatesBuf: string; contextTokens: object };
    }).pollState = {
      updatesBuf: "",
      contextTokens: {},
      lastMessageId: 5, // pretend we've already seen up to id 5
    };

    // Persist messages 4, 5, 6 in order. 4 and 5 should be skipped, 6
    // should make it through.
    for (const id of [4, 5, 6]) {
      await (
        adapter as unknown as {
          persistIncomingMessage: (m: IlinkMessage) => Promise<void>;
        }
      ).persistIncomingMessage(makeIlinkMessage(id));
    }

    expect(await state.queueDepth("wechat-acp:pending")).toBe(1);
    expect(
      (adapter as unknown as { pollState: { lastMessageId: number } })
        .pollState.lastMessageId
    ).toBe(6);
  });

  it("startQrLogin() returns the QR image immediately and the result resolves on confirmed", async () => {
    let saved: unknown = null;
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "scan-only",
      accountStorage: {
        load: async () => null,
        save: async (data) => {
          saved = data;
        },
      },
    });

    // Two poll responses: first "wait", then "confirmed". Verifies the
    // loop actually iterates and doesn't just resolve on the first call.
    const statuses: Array<{ status: "wait" | "confirmed"; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string }> = [
      { status: "wait" },
      {
        status: "confirmed",
        bot_token: "tok",
        ilink_bot_id: "ilink-bot",
        ilink_user_id: "ilink-user",
      },
    ];
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: vi.fn(async () => statuses.shift()!),
      setToken: () => {},
    };

    const session = await adapter.startQrLogin();
    // QR image is returned synchronously w.r.t. the awaited startQrLogin.
    expect(session.qrcode.imageBase64).toBe("base64-png");
    // Result resolves once the second poll returns confirmed.
    const account = await session.result;
    expect(account.botToken).toBe("tok");
    expect(saved).toEqual(account);
  });

  it("startQrLogin() result rejects with QrLoginError('expired') when iLink expires the code", async () => {
    const { QrLoginError } = await import("../../src/acp/acp-adapter.js");
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "scan-only",
    });
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: async () => ({ status: "expired" }),
      setToken: () => {},
    };

    const session = await adapter.startQrLogin();
    await expect(session.result).rejects.toBeInstanceOf(QrLoginError);
    await expect(session.result).rejects.toMatchObject({ code: "expired" });
  });

  it("startQrLogin() result rejects with QrLoginError('cancelled') when cancel() is called", async () => {
    const { QrLoginError } = await import("../../src/acp/acp-adapter.js");
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "scan-only",
    });
    let pollCalls = 0;
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: async () => {
        pollCalls++;
        // Tiny delay so the test can call cancel mid-poll.
        await new Promise((r) => setTimeout(r, 5));
        return { status: "wait" } as const;
      },
      setToken: () => {},
    };

    const session = await adapter.startQrLogin();
    // Let one poll iteration happen, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    session.cancel();
    await expect(session.result).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(pollCalls).toBeGreaterThan(0);
  });

  it("disconnect() cancels in-flight QR login sessions", async () => {
    const { QrLoginError } = await import("../../src/acp/acp-adapter.js");
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "scan-only",
    });
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { status: "wait" } as const;
      },
      setToken: () => {},
    };

    const session = await adapter.startQrLogin();
    // Give the loop a tick to enter, then disconnect.
    await new Promise((r) => setTimeout(r, 10));
    await adapter.disconnect();
    await expect(session.result).rejects.toBeInstanceOf(QrLoginError);
    await expect(session.result).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("startQrLogin() result has its own .catch so an unawaited rejection does not crash the process", async () => {
    // Regression: previously a result promise that rejected without an
    // attached handler would surface as an unhandled rejection. Now
    // startQrLogin attaches an internal .catch(noop). This test
    // verifies the rejection is observable to the caller AND that
    // process.on('unhandledRejection') would not fire.
    const { QrLoginError } = await import("../../src/acp/acp-adapter.js");
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "scan-only",
    });
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: async () => ({ status: "expired" }),
      setToken: () => {},
    };

    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const session = await adapter.startQrLogin();
      // Deliberately do NOT attach a handler to session.result.
      // Wait long enough for the rejection to propagate.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toBeNull();
    // ... but explicit awaiters still see the rejection.
    const session = await adapter.startQrLogin();
    await expect(session.result).rejects.toBeInstanceOf(QrLoginError);
  });

  it("loginWithQr() (convenience wrapper) still works for the interactive case", async () => {
    let saved: unknown = null;
    const onQrCode = vi.fn();
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
      botId: "interactive",
      onQrCode,
      accountStorage: {
        load: async () => null,
        save: async (data) => {
          saved = data;
        },
      },
    });
    (adapter as unknown as { client: unknown }).client = {
      fetchQrCode: async () => ({
        qrcode: "qr-token",
        qrcode_img_content: "base64-png",
      }),
      pollQrStatus: async () => ({
        status: "confirmed",
        bot_token: "tok",
        ilink_bot_id: "ilink-bot",
        ilink_user_id: "ilink-user",
      }),
      setToken: () => {},
    };

    const account = await adapter.loginWithQr();
    expect(account.botToken).toBe("tok");
    expect(saved).toEqual(account);
    expect(onQrCode).toHaveBeenCalledOnce();
    expect(onQrCode.mock.calls[0]![1]).toEqual({
      botId: "interactive",
      metadata: undefined,
    });
  });

  it("rehydrates messages after a JSON roundtrip through the state adapter", async () => {
    // Simulates state-pg's JSON serialization: messages come back out of
    // dequeue as plain objects, not Message instances. The adapter must
    // rebuild a real Message before handing it to chat.processMessage.
    const state = createInMemoryState();
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example",
    });
    const { chat, processMessage } = createFakeChat(state);
    (adapter as unknown as { chat: ChatInstance }).chat = chat;

    // Manually enqueue a JSON-roundtripped Message.
    const sampleRaw = {
      messageId: 99,
      fromUserId: "user_99",
      toUserId: "bot",
      text: "hi",
      createTime: 1_700_000_000_000,
      contextToken: "ctx_99",
      media: [],
      raw: {},
    };
    const liveMessage = adapter.parseMessage(sampleRaw);
    const serialized = JSON.parse(JSON.stringify(liveMessage));
    await state.enqueue(
      PENDING_QUEUE_KEY,
      {
        message: serialized,
        enqueuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      100
    );

    await (
      adapter as unknown as { drainPendingQueue: () => Promise<void> }
    ).drainPendingQueue();

    expect(processMessage).toHaveBeenCalledTimes(1);
    const dispatched = processMessage.mock.calls[0]![2] as Message;
    expect(dispatched).toBeInstanceOf(Message);
    expect(dispatched.id).toBe("99");
    expect(dispatched.text).toBe("hi");
  });
});
