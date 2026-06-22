/**
 * Comprehensive tests for spec compliance.
 * Covers: group chat, streaming, error handling, persistence, config, edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWeChatAcpAdapter, WeChatAcpAdapter } from "../../src/acp/index.js";
import { IlinkClient } from "../../src/acp/acp-client.js";
import type { WeChatRawMessage } from "../../src/core/types.js";

// --- Group Chat Tests (§18) ---

describe("group chat support", () => {
  const makeAdapter = () =>
    createWeChatAcpAdapter({ baseUrl: "https://test.example.com" });

  it("parseMessage creates group thread ID when groupId present", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 100,
      fromUserId: "user1",
      toUserId: "bot1",
      groupId: "grp_abc",
      text: "Hello group",
      createTime: Date.now(),
      media: [],
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    expect(msg.threadId).toBe("wechat:group:grp_abc");
    expect(msg.author.userId).toBe("user1"); // individual sender
  });

  it("parseMessage creates DM thread ID when no groupId", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 101,
      fromUserId: "user2",
      toUserId: "bot1",
      text: "Hello DM",
      createTime: Date.now(),
      media: [],
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    expect(msg.threadId).toBe("wechat:dm:user2");
  });

  it("isDM returns false for group threads", () => {
    const adapter = makeAdapter();
    expect(adapter.isDM("wechat:group:grp_abc:ctx")).toBe(false);
  });

  it("isDM returns true for DM threads", () => {
    const adapter = makeAdapter();
    expect(adapter.isDM("wechat:dm:user1:ctx")).toBe(true);
  });

  it("channelIdFromThreadId strips context for groups", () => {
    const adapter = makeAdapter();
    expect(adapter.channelIdFromThreadId("wechat:group:grp_abc:ctx")).toBe(
      "wechat:group:grp_abc"
    );
  });

  it("fetchThread returns isDM false for group threads", async () => {
    const adapter = makeAdapter();
    const info = await adapter.fetchThread("wechat:group:grp_abc:ctx");
    expect(info.isDM).toBe(false);
    expect(info.channelId).toBe("wechat:group:grp_abc");
  });

  it("fetchThread returns isDM true for DM threads", async () => {
    const adapter = makeAdapter();
    const info = await adapter.fetchThread("wechat:dm:user1:ctx");
    expect(info.isDM).toBe(true);
    expect(info.channelId).toBe("wechat:dm:user1");
  });

  it("parseMessage with contextToken in group message", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 102,
      fromUserId: "user3",
      toUserId: "bot1",
      groupId: "grp_xyz",
      text: "Test",
      createTime: Date.now(),
      contextToken: "ctx_group",
      media: [],
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    expect(msg.threadId).toBe("wechat:group:grp_xyz:ctx_group");
  });
});

// --- Streaming Tests (§9) ---

describe("streaming", () => {
  it("accumulates text chunks and sends final message", async () => {
    const adapter = makeAdapter();

    // Mock postMessage to capture what's sent
    const postSpy = vi.fn().mockResolvedValue({
      id: "1",
      threadId: "wechat:dm:user1",
      raw: {},
    });
    (adapter as any).postMessage = postSpy;

    async function* textStream() {
      yield "Hello ";
      yield "world";
      yield "!";
    }

    await adapter.stream("wechat:dm:user1", textStream());
    expect(postSpy).toHaveBeenCalledWith("wechat:dm:user1", "Hello world!");
  });

  it("handles StreamChunk types", async () => {
    const adapter = makeAdapter();

    const postSpy = vi.fn().mockResolvedValue({
      id: "1",
      threadId: "wechat:dm:user1",
      raw: {},
    });
    (adapter as any).postMessage = postSpy;

    async function* mixedStream() {
      yield { type: "markdown_text" as const, text: "Hello " };
      yield "world";
      yield { type: "task_update" as const, id: "t1", title: "Task", status: "complete" as const };
      yield { type: "plan_update" as const, title: "Plan" };
    }

    await adapter.stream("wechat:dm:user1", mixedStream());
    // task_update and plan_update should be ignored
    expect(postSpy).toHaveBeenCalledWith("wechat:dm:user1", "Hello world");
  });

  it("empty stream sends empty message", async () => {
    const adapter = makeAdapter();

    const postSpy = vi.fn().mockResolvedValue({
      id: "1",
      threadId: "wechat:dm:user1",
      raw: {},
    });
    (adapter as any).postMessage = postSpy;

    async function* emptyStream() {
      // yields nothing
    }

    await adapter.stream("wechat:dm:user1", emptyStream());
    expect(postSpy).toHaveBeenCalledWith("wechat:dm:user1", "");
  });

  function makeAdapter() {
    return createWeChatAcpAdapter({ baseUrl: "https://test.example.com" });
  }
});

// --- Error Handling Tests (§13) ---

describe("error handling", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws AdapterRateLimitError on HTTP 429", async () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
    });

    mockFetch.mockResolvedValueOnce(
      new Response("Too Many Requests", { status: 429 })
    );

    await expect(
      client.sendMessage({ toUserId: "u", text: "hi", contextToken: "c" })
    ).rejects.toThrow("Rate limit");
  });

  it("throws AuthenticationError on HTTP 401", async () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
    });

    mockFetch.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    await expect(
      client.sendMessage({ toUserId: "u", text: "hi", contextToken: "c" })
    ).rejects.toThrow("Unauthorized");
  });

  it("throws AdapterRateLimitError on ilink error code 210205", async () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
    });

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: 210205, errmsg: "rate limited" }), {
        status: 200,
      })
    );

    await expect(
      client.sendMessage({ toUserId: "u", text: "hi", contextToken: "c" })
    ).rejects.toThrow("Rate limit");
  });

  it("throws on non-zero ilink business response codes", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
      logger,
    });

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ret: -3, errmsg: "send failed" }), {
        status: 200,
      })
    );

    await expect(
      client.sendMessage({ toUserId: "u", text: "hi", contextToken: "c" })
    ).rejects.toThrow("ilink/bot/sendmessage failed");

    expect(logger.warn).toHaveBeenCalledWith(
      "iLink API returned business error",
      {
        endpoint: "ilink/bot/sendmessage",
        errcode: undefined,
        errmsg: "send failed",
        ret: -3,
      }
    );
  });

  it("retries sendMessage once without context token for stale-token response", async () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
    });

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ret: -2, errmsg: "unknown" }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ret: 0 }), { status: 200 })
      );

    const result = await client.sendMessage({
      toUserId: "u",
      text: "hi",
      contextToken: "stale-context-token",
    });

    expect(result).toEqual({ retriedWithoutContextToken: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(mockFetch.mock.calls[0]![1].body);
    const retryBody = JSON.parse(mockFetch.mock.calls[1]![1].body);
    expect(firstBody.msg.context_token).toBe("stale-context-token");
    expect(retryBody.msg.context_token).toBe("");
  });

  it("throws when stale-token retry also fails", async () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
    });

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ret: -2, errmsg: "" }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ret: -4, errmsg: "retry failed" }), {
          status: 200,
        })
      );

    await expect(
      client.sendMessage({
        toUserId: "u",
        text: "hi",
        contextToken: "stale-context-token",
      })
    ).rejects.toThrow("ilink/bot/sendmessage failed");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// --- Outbound Send State Tests ---

describe("outbound send state", () => {
  it("drops cached context token after tokenless sendMessage retry succeeds", async () => {
    const saveState = vi.fn();
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example.com",
      stateStorage: {
        load: vi.fn(),
        save: saveState,
      },
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ retriedWithoutContextToken: true });

    (adapter as any).client = { sendMessage };
    (adapter as any).pollState = {
      updatesBuf: "",
      contextTokens: { user1: "stale-context-token" },
      lastMessageId: 0,
    };

    const result = await adapter.postMessage("wechat:dm:user1", "hello");

    expect(sendMessage).toHaveBeenCalledWith({
      toUserId: "user1",
      text: "hello",
      contextToken: "stale-context-token",
      images: undefined,
    });
    expect((adapter as any).pollState.contextTokens).toEqual({});
    expect(saveState).toHaveBeenCalledWith({
      updatesBuf: "",
      contextTokens: {},
      lastMessageId: 0,
    });
    expect(result.raw.contextToken).toBe("");
  });
});

// --- Message Parsing Edge Cases (§6) ---

describe("message parsing edge cases", () => {
  const makeAdapter = () =>
    createWeChatAcpAdapter({ baseUrl: "https://test.example.com" });

  it("handles multiple media items in single message", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 200,
      fromUserId: "user1",
      toUserId: "bot1",
      text: "Two images",
      createTime: Date.now(),
      media: [
        {
          kind: "image",
          encryptQueryParam: "param1",
          aesKey: "0123456789abcdef0123456789abcdef",
        },
        {
          kind: "image",
          encryptQueryParam: "param2",
          aesKey: "fedcba9876543210fedcba9876543210",
        },
      ],
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    expect(msg.attachments).toHaveLength(2);
    expect(msg.attachments[0]!.type).toBe("image");
    expect(msg.attachments[1]!.type).toBe("image");
  });

  it("handles ref_msg with media but no text", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 201,
      fromUserId: "user1",
      toUserId: "bot1",
      text: "About this",
      createTime: Date.now(),
      media: [],
      refMsg: {
        mediaItem: {
          kind: "file",
          encryptQueryParam: "file_param",
          aesKey: "0123456789abcdef0123456789abcdef",
          fileName: "doc.pdf",
        },
      },
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.type).toBe("file");
    expect(msg.attachments[0]!.name).toBe("doc.pdf");
  });

  it("handles ref_msg title-only (no text field)", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 202,
      fromUserId: "user1",
      toUserId: "bot1",
      text: "Reply",
      createTime: Date.now(),
      media: [],
      refMsg: {
        title: "Quoted Title",
      },
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    expect(msg.formatted.children[0]!.type).toBe("blockquote");
  });

  it("handles empty text message", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 203,
      fromUserId: "user1",
      toUserId: "bot1",
      text: "",
      createTime: Date.now(),
      media: [],
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    expect(msg.text).toBe("");
    expect(msg.formatted.type).toBe("root");
  });

  it("isMention is always true", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 204,
      fromUserId: "user1",
      toUserId: "bot1",
      text: "not explicitly mentioning anyone",
      createTime: Date.now(),
      media: [],
      raw: {},
    };

    expect(adapter.parseMessage(raw).isMention).toBe(true);
  });

  it("handles mixed direct media + ref_msg media", () => {
    const adapter = makeAdapter();
    const raw: WeChatRawMessage = {
      messageId: 205,
      fromUserId: "user1",
      toUserId: "bot1",
      text: "Both",
      createTime: Date.now(),
      media: [
        {
          kind: "image",
          encryptQueryParam: "direct_param",
          aesKey: "0123456789abcdef0123456789abcdef",
        },
      ],
      refMsg: {
        text: "Quoted",
        mediaItem: {
          kind: "image",
          encryptQueryParam: "ref_param",
          aesKey: "fedcba9876543210fedcba9876543210",
        },
      },
      raw: {},
    };

    const msg = adapter.parseMessage(raw);
    // 1 direct + 1 from ref
    expect(msg.attachments).toHaveLength(2);
  });
});

// --- Unsupported Operations Tests (§11) ---

describe("unsupported operations", () => {
  const adapter = createWeChatAcpAdapter({
    baseUrl: "https://test.example.com",
  });

  it("editMessage throws AdapterError", async () => {
    await expect(adapter.editMessage()).rejects.toThrow(
      "does not support editing"
    );
  });

  it("deleteMessage throws AdapterError", async () => {
    await expect(adapter.deleteMessage()).rejects.toThrow(
      "does not support deleting"
    );
  });

  it("addReaction is a no-op", async () => {
    await expect(adapter.addReaction()).resolves.toBeUndefined();
  });

  it("removeReaction is a no-op", async () => {
    await expect(adapter.removeReaction()).resolves.toBeUndefined();
  });

  it("handleWebhook returns 200", async () => {
    const response = await adapter.handleWebhook();
    expect(response.status).toBe(200);
  });

  it("fetchMessages returns empty", async () => {
    const result = await adapter.fetchMessages("wechat:dm:user1");
    expect(result.messages).toEqual([]);
  });

  it("fetchMessage returns null", async () => {
    const result = await adapter.fetchMessage("wechat:dm:user1", "123");
    expect(result).toBeNull();
  });

  it("openDM returns DM thread ID", async () => {
    const threadId = await adapter.openDM("user123");
    expect(threadId).toBe("wechat:dm:user123");
  });
});

// --- Config Defaults Tests (§3) ---

describe("config defaults", () => {
  it("uses correct default values", () => {
    const adapter = createWeChatAcpAdapter();
    // Should not throw — all defaults applied
    expect(adapter.name).toBe("wechat-acp");
    expect(adapter.lockScope).toBe("channel");
    expect(adapter.persistMessageHistory).toBe(true);
  });
});

// --- Format Converter Edge Cases (§12) ---

describe("format converter edge cases", () => {
  const makeAdapter = () =>
    createWeChatAcpAdapter({ baseUrl: "https://test.example.com" });

  it("renderFormatted converts AST to plain text", () => {
    const adapter = makeAdapter();
    const ast = {
      type: "root" as const,
      children: [
        {
          type: "paragraph" as const,
          children: [{ type: "text" as const, value: "Hello world" }],
        },
      ],
    };
    expect(adapter.renderFormatted(ast)).toBe("Hello world");
  });

  it("renderFormatted strips formatting nodes", () => {
    const adapter = makeAdapter();
    const ast = {
      type: "root" as const,
      children: [
        {
          type: "paragraph" as const,
          children: [
            {
              type: "strong" as const,
              children: [{ type: "text" as const, value: "bold" }],
            },
            { type: "text" as const, value: " text" },
          ],
        },
      ],
    };
    expect(adapter.renderFormatted(ast)).toBe("bold text");
  });
});
