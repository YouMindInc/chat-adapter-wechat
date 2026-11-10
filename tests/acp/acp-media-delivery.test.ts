import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWeChatAcpAdapter } from "../../src/acp/index.js";
import { IlinkClient } from "../../src/acp/acp-client.js";
import { MessageItemType, UploadMediaType } from "../../src/acp/acp-types.js";
import { aesEcbDecrypt } from "../../src/core/media.js";

describe("ACP media delivery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let uploadParams: Record<string, any>[];
  let uploadBodies: Buffer[];
  let uploadSignals: (AbortSignal | undefined)[];
  let sends: Record<string, any>[];
  let rejectStaleContext: boolean;
  const data = Buffer.from("seventeen bytes!!");

  const response = (body: unknown) => new Response(JSON.stringify(body));

  beforeEach(() => {
    uploadParams = [];
    uploadBodies = [];
    uploadSignals = [];
    sends = [];
    rejectStaleContext = false;
    fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/ilink/bot/getuploadurl")) {
        uploadParams.push(JSON.parse(String(options.body)));
        return response({ upload_full_url: "https://cdn.example.com/upload" });
      }
      if (url === "https://cdn.example.com/upload") {
        uploadBodies.push(Buffer.from(options.body as Uint8Array));
        uploadSignals.push(options.signal ?? undefined);
        return new Response("", { headers: { "x-encrypted-param": "cdn-param" } });
      }
      if (url.endsWith("/ilink/bot/sendmessage")) {
        sends.push(JSON.parse(String(options.body)));
        return response(rejectStaleContext && sends.length === 1
          ? { ret: -2, errmsg: "context_token expired" }
          : { ret: 0 });
      }
      if (url.endsWith("/ilink/bot/getconfig")) return response({ typing_ticket: "ticket" });
      if (url.endsWith("/ilink/bot/sendtyping")) return response({ ret: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function adapter() {
    return createWeChatAcpAdapter({
      baseUrl: "https://ilink.example.com",
      stateStorage: { load: async () => null, save: async () => {} },
    });
  }

  it.each([
    ["picture.png", "image/png", UploadMediaType.IMAGE, MessageItemType.IMAGE],
    ["movie.mp4", "video/mp4", UploadMediaType.VIDEO, MessageItemType.VIDEO],
    ["report.pdf", "application/pdf", UploadMediaType.FILE, MessageItemType.FILE],
  ])("uploads and sends %s with the right protocol type", async (filename, mimeType, uploadType, itemType) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await adapter().postMessage("wechat:dm:user:ctx", {
      text: "attachment",
      files: [{ filename, mimeType, data }],
    });

    expect(uploadParams).toHaveLength(1);
    expect(uploadParams[0]).toMatchObject({ media_type: uploadType, to_user_id: "user", rawsize: data.length });
    expect(aesEcbDecrypt(uploadBodies[0]!, Buffer.from(uploadParams[0]!.aeskey, "hex"))).toEqual(data);
    const item = sends[0]!.msg.item_list[1];
    expect(item.type).toBe(itemType);
    const payload = item.image_item ?? item.video_item ?? item.file_item;
    expect(payload.media).toMatchObject({ encrypt_query_param: "cdn-param", encrypt_type: 1 });
    expect(Buffer.from(payload.media.aes_key, "base64").toString()).toBe(uploadParams[0]!.aeskey);
    if (uploadType === UploadMediaType.FILE) {
      expect(payload).toMatchObject({ file_name: filename, len: String(data.length) });
    } else {
      expect(payload.mid_size ?? payload.video_size).toBe(uploadBodies[0]!.length);
    }
    if (uploadType === UploadMediaType.IMAGE) {
      expect(uploadSignals[0]).toBeUndefined();
      expect(timeout).not.toHaveBeenCalled();
    } else {
      expect(uploadSignals[0]).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(60_000);
    }
  });

  it("keeps image detection by filename and supports ArrayBuffer file data", async () => {
    await adapter().postMessage("wechat:dm:user:ctx", {
      text: "files",
      files: [
        { filename: "picture.PNG", data },
        { filename: "notes.txt", mimeType: "text/plain", data: new Uint8Array(data).buffer },
      ],
    });
    expect(uploadParams.map((p) => p.media_type)).toEqual([UploadMediaType.IMAGE, UploadMediaType.FILE]);
    expect(sends[0]!.msg.item_list.map((i: any) => i.type)).toEqual([MessageItemType.TEXT, MessageItemType.IMAGE, MessageItemType.FILE]);
  });

  it("does not send when upload fails and exposes the upload-stage marker", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options: RequestInit) =>
      url === "https://cdn.example.com/upload"
        ? Promise.resolve(new Response("rejected", { status: 403 }))
        : normalFetch(url, options),
    );

    await expect(adapter().postMessage("wechat:dm:user:ctx", {
      text: "attachment",
      files: [{ filename: "movie.mp4", mimeType: "video/mp4", data }],
    })).rejects.toMatchObject({ wechatDeliveryStage: "upload" });
    expect(sends).toHaveLength(0);
  });

  it("retains media on tokenless send retry without uploading it again", async () => {
    rejectStaleContext = true;
    await adapter().postMessage("wechat:dm:user:stale", {
      text: "attachment",
      files: [{ filename: "report.pdf", mimeType: "application/pdf", data }],
    });
    expect(uploadBodies).toHaveLength(1);
    expect(sends).toHaveLength(2);
    expect(sends[0]!.msg.context_token).toBe("stale");
    expect(sends[1]!.msg.context_token).toBe("");
    expect(sends[1]!.msg.item_list).toEqual(sends[0]!.msg.item_list);
  });

  it("uses the official stop-typing status", async () => {
    const instance = adapter();
    (instance as any).pollState.contextTokens.user = "ctx";
    await instance.stopTyping("wechat:dm:user");
    const send = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/ilink/bot/sendtyping"));
    expect(JSON.parse(String(send![1]!.body))).toMatchObject({ status: 2, typing_ticket: "ticket" });
  });

  it("aborts a bounded CDN upload when its deadline expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("upload timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    fetchMock.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    }));
    const client = new IlinkClient({ baseUrl: "https://ilink.example.com", cdnBaseUrl: "https://cdn.example.com" });
    const result = expect(client.uploadToCdn("https://cdn.example.com/upload", data, 60_000)).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
  });
});
