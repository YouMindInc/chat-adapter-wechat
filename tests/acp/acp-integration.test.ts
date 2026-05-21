/**
 * Integration tests that mock the ilink HTTP endpoints to test the full
 * poll → parse → processMessage → postMessage flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IlinkClient } from "../../src/acp/acp-client.js";
import type { IlinkGetUpdatesResponse } from "../../src/acp/bot-types.js";

describe("IlinkClient with mocked fetch", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockResponse(body: unknown, status = 200, headers?: Record<string, string>) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  describe("getUpdates", () => {
    it("sends correct request and parses response", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      const responseBody: IlinkGetUpdatesResponse = {
        ret: 0,
        msgs: [
          {
            message_id: 1,
            from_user_id: "wx_user_1",
            to_user_id: "wx_bot_1",
            message_type: 1, // USER
            create_time_ms: 1700000000000,
            item_list: [
              { type: 1, text_item: { text: "Hello from user" } },
            ],
            context_token: "ctx_abc",
          },
        ],
        get_updates_buf: "cursor_123",
      };

      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      const result = await client.getUpdates("");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.get_updates_buf).toBe("");
      expect(body.base_info.channel_version).toBe("1.0.2");

      expect(result.msgs).toHaveLength(1);
      expect(result.msgs![0]!.from_user_id).toBe("wx_user_1");
      expect(result.get_updates_buf).toBe("cursor_123");
    });

    it("passes cursor for subsequent polls", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      mockFetch.mockResolvedValueOnce(
        mockResponse({ ret: 0, msgs: [], get_updates_buf: "cursor_456" })
      );

      await client.getUpdates("cursor_123");

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.get_updates_buf).toBe("cursor_123");
    });

    it("keeps the client timeout above the server long-poll hold window", async () => {
      vi.useFakeTimers();
      try {
        const client = new IlinkClient({
          baseUrl: "https://ilinkai.weixin.qq.com",
          cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
          token: "test-token",
        });

        let requestSignal: AbortSignal | undefined;
        mockFetch.mockImplementationOnce((_url, options) => {
          requestSignal = options.signal;
          return new Promise((_resolve, reject) => {
            requestSignal!.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" })
              );
            });
          });
        });

        const result = client.getUpdates("cursor_123");

        await vi.advanceTimersByTimeAsync(25_000);
        expect(requestSignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(5_000);
        await expect(result).resolves.toEqual({
          ret: 0,
          msgs: [],
          get_updates_buf: "cursor_123",
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("sendMessage", () => {
    it("sends text message with correct ilink format", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));

      await client.sendMessage({
        toUserId: "wx_user_1",
        text: "Hello from bot",
        contextToken: "ctx_abc",
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage"
      );

      const body = JSON.parse(options.body);
      expect(body.msg.to_user_id).toBe("wx_user_1");
      expect(body.msg.from_user_id).toBe("");
      expect(body.msg.message_type).toBe(2); // BOT
      expect(body.msg.message_state).toBe(2); // FINISH
      expect(body.msg.context_token).toBe("ctx_abc");
      expect(body.msg.item_list).toHaveLength(1);
      expect(body.msg.item_list[0]).toEqual({
        type: 1,
        text_item: { text: "Hello from bot" },
      });
      expect(body.base_info.channel_version).toBe("1.0.2");

      // Verify headers match wxcodex format
      const headers = options.headers;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["AuthorizationType"]).toBe("ilink_bot_token");
      expect(headers["Authorization"]).toBe("Bearer test-token");
    });

    it("sends text + image message", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));

      await client.sendMessage({
        toUserId: "wx_user_1",
        text: "Here is an image",
        contextToken: "ctx_abc",
        images: [
          {
            encryptQueryParam: "cdn_param_xyz",
            aesKeyB64: "base64key==",
            ciphertextSize: 4096,
          },
        ],
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.msg.item_list).toHaveLength(2);
      expect(body.msg.item_list[0].type).toBe(1); // TEXT
      expect(body.msg.item_list[1].type).toBe(2); // IMAGE
      expect(body.msg.item_list[1].image_item.media).toEqual({
        encrypt_query_param: "cdn_param_xyz",
        aes_key: "base64key==",
        encrypt_type: 1,
      });
      expect(body.msg.item_list[1].image_item.mid_size).toBe(4096);
    });
  });

  describe("sendTyping", () => {
    it("fetches config then sends typing", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      // getConfig response
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ret: 0, typing_ticket: "ticket_123" })
      );
      // sendTyping response
      mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));

      const config = await client.getConfig("wx_user_1", "ctx_abc");
      expect(config.typing_ticket).toBe("ticket_123");

      await client.sendTyping("wx_user_1", "ticket_123", 1);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify getConfig request
      const [configUrl, configOpts] = mockFetch.mock.calls[0]!;
      expect(configUrl).toBe(
        "https://ilinkai.weixin.qq.com/ilink/bot/getconfig"
      );
      const configBody = JSON.parse(configOpts.body);
      expect(configBody.ilink_user_id).toBe("wx_user_1");
      expect(configBody.context_token).toBe("ctx_abc");

      // Verify sendTyping request
      const [typingUrl, typingOpts] = mockFetch.mock.calls[1]!;
      expect(typingUrl).toBe(
        "https://ilinkai.weixin.qq.com/ilink/bot/sendtyping"
      );
      const typingBody = JSON.parse(typingOpts.body);
      expect(typingBody.ilink_user_id).toBe("wx_user_1");
      expect(typingBody.typing_ticket).toBe("ticket_123");
      expect(typingBody.status).toBe(1);
    });
  });

  describe("QR login flow", () => {
    it("fetches QR code then polls status until confirmed", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      });

      // fetchQrCode
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          qrcode: "qr_code_string",
          qrcode_img_content: "base64_image_data",
        })
      );

      const qr = await client.fetchQrCode();
      expect(qr.qrcode).toBe("qr_code_string");
      expect(qr.qrcode_img_content).toBe("base64_image_data");

      const [qrUrl] = mockFetch.mock.calls[0]!;
      expect(qrUrl).toBe(
        "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3"
      );

      // pollQrStatus - first wait, then confirmed
      mockFetch.mockResolvedValueOnce(mockResponse({ status: "wait" }));
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          status: "confirmed",
          bot_token: "new_bot_token",
          ilink_bot_id: "bot_001",
          ilink_user_id: "user_001",
        })
      );

      const status1 = await client.pollQrStatus("qr_code_string");
      expect(status1.status).toBe("wait");

      const status2 = await client.pollQrStatus("qr_code_string");
      expect(status2.status).toBe("confirmed");
      expect(status2.bot_token).toBe("new_bot_token");
    });
  });

  describe("media CDN", () => {
    it("gets upload URL and uploads to CDN", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      // getUploadUrl
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          upload_full_url: "https://cdn.example.com/upload?key=abc",
        })
      );

      const uploadUrl = await client.getUploadUrl({
        filekey: "fk_123",
        mediaType: 1,
        toUserId: "wx_user_1",
        rawSize: 1000,
        rawFileMd5: "abc123",
        fileSize: 1024,
        aesKeyHex: "0123456789abcdef0123456789abcdef",
      });

      expect(uploadUrl.upload_full_url).toBe(
        "https://cdn.example.com/upload?key=abc"
      );

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.filekey).toBe("fk_123");
      expect(body.media_type).toBe(1);
      expect(body.rawsize).toBe(1000);
      expect(body.no_need_thumb).toBe(true);

      // uploadToCdn
      mockFetch.mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { "x-encrypted-param": "download_param_xyz" },
        })
      );

      const downloadParam = await client.uploadToCdn(
        "https://cdn.example.com/upload?key=abc",
        Buffer.from("encrypted_data")
      );
      expect(downloadParam).toBe("download_param_xyz");

      const [cdnUrl, cdnOpts] = mockFetch.mock.calls[1]!;
      expect(cdnUrl).toBe("https://cdn.example.com/upload?key=abc");
      expect(cdnOpts.headers["Content-Type"]).toBe(
        "application/octet-stream"
      );
    });

    it("downloads from CDN", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      mockFetch.mockResolvedValueOnce(
        new Response(imageBytes, { status: 200 })
      );

      const result = await client.downloadFromCdn("encrypted_param_abc");

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=encrypted_param_abc"
      );
      expect(result.length).toBe(4);
    });

    it("uses upload_param fallback when upload_full_url is absent", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      mockFetch.mockResolvedValueOnce(
        mockResponse({ upload_param: "legacy_upload_param" })
      );

      const uploadUrl = await client.getUploadUrl({
        filekey: "fk_456",
        mediaType: 1,
        toUserId: "user",
        rawSize: 100,
        rawFileMd5: "md5",
        fileSize: 112,
        aesKeyHex: "0123456789abcdef0123456789abcdef",
      });

      expect(uploadUrl.upload_param).toBe("legacy_upload_param");
      expect(uploadUrl.upload_full_url).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("throws NetworkError on non-OK response", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      mockFetch.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 })
      );

      await expect(
        client.sendMessage({ toUserId: "u", text: "hi", contextToken: "c" })
      ).rejects.toThrow("500");
    });

    it("returns empty msgs on getUpdates abort", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      mockFetch.mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError" })
      );

      const result = await client.getUpdates("cursor_1");
      expect(result.ret).toBe(0);
      expect(result.msgs).toEqual([]);
      expect(result.get_updates_buf).toBe("cursor_1");
    });

    it("throws NetworkError on CDN upload missing x-encrypted-param", async () => {
      const client = new IlinkClient({
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
        token: "test-token",
      });

      mockFetch.mockResolvedValueOnce(
        new Response("ok", { status: 200 })
      );

      await expect(
        client.uploadToCdn("https://cdn.example.com/upload", Buffer.from("data"))
      ).rejects.toThrow("x-encrypted-param");
    });
  });
});
