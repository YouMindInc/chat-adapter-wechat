import crypto from "node:crypto";
import {
  NetworkError,
  AuthenticationError,
  AdapterRateLimitError,
} from "@chat-adapter/shared";
import {
  DEFAULT_API_TIMEOUT_MS,
  GETUPDATES_LONG_POLL_TIMEOUT_MS,
  QR_LONG_POLL_TIMEOUT_MS,
  CHANNEL_VERSION,
  BOT_TYPE,
  ClientLogger,
} from "../core/types.js";
import type {
  IlinkGetUpdatesResponse,
  IlinkGetConfigResponse,
  IlinkQrCodeResponse,
  IlinkQrStatusResponse,
  IlinkUploadUrlResponse,
  IlinkMessageItem,
} from "./acp-types.js";
import { MessageType, MessageState, MessageItemType } from "./acp-types.js";

export interface IlinkClientConfig {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  logger?: ClientLogger;
}

export interface SendMessageParams {
  toUserId: string;
  text?: string;
  contextToken?: string;
  images?: Array<{
    encryptQueryParam: string;
    aesKeyB64: string;
    ciphertextSize: number;
  }>;
}

export interface SendMessageResult {
  retriedWithoutContextToken: boolean;
}

class IlinkBusinessError extends NetworkError {
  readonly endpoint: string;
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;

  constructor(
    endpoint: string,
    details: { ret?: number; errcode?: number; errmsg?: string }
  ) {
    super("wechat-acp", `${endpoint} failed`);
    this.name = "IlinkBusinessError";
    this.endpoint = endpoint;
    this.ret = details.ret;
    this.errcode = details.errcode;
    this.errmsg = details.errmsg;
  }
}

export class IlinkClient {
  private baseUrl: string;
  private cdnBaseUrl: string;
  private token: string | undefined;
  private readonly logger?: ClientLogger;

  constructor(config: IlinkClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.cdnBaseUrl = config.cdnBaseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.logger = config.logger;
  }

  setToken(token: string): void {
    this.token = token;
  }

  buildHeaders(body: string): Record<string, string> {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    const uin = Buffer.from(String(uint32), "utf-8").toString("base64");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(body, "utf-8")),
      "X-WECHAT-UIN": uin,
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    return headers;
  }

  private baseInfo() {
    return { channel_version: CHANNEL_VERSION };
  }

  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<T> {
    const jsonBody = JSON.stringify({ ...body, base_info: this.baseInfo() });
    const url = `${this.baseUrl}/${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(jsonBody),
        body: jsonBody,
        signal: combinedSignal,
      });

      const text = await response.text();
      if (!response.ok) {
        this.logger?.warn("HTTP error from iLink API", {
          endpoint,
          status: response.status,
          body: text.slice(0, 200),
        });
        if (response.status === 429) {
          throw new AdapterRateLimitError("wechat-acp");
        }
        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError("wechat-acp", `${endpoint}: ${text}`);
        }
        throw new NetworkError(
          "wechat-acp",
          `${endpoint} ${response.status}: ${text}`
        );
      }
      const parsed = JSON.parse(text) as T & {
        ret?: number;
        errcode?: number;
        errmsg?: string;
      };
      // Check ilink-level error codes
      if (parsed.errcode === 210205 || parsed.ret === 210205) {
        this.logger?.warn("iLink rate limit hit", { endpoint });
        throw new AdapterRateLimitError("wechat-acp");
      }
      if (isIlinkBusinessFailure(parsed)) {
        this.logger?.warn("iLink API returned business error", {
          endpoint,
          ret: parsed.ret,
          errcode: parsed.errcode,
          errmsg: sanitizeIlinkMessage(parsed.errmsg),
        });
        throw new IlinkBusinessError(endpoint, {
          ret: parsed.ret,
          errcode: parsed.errcode,
          errmsg: parsed.errmsg,
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (
        error instanceof NetworkError ||
        error instanceof AdapterRateLimitError ||
        error instanceof AuthenticationError
      ) {
        throw error;
      }
      throw new NetworkError(
        "wechat-acp",
        `${endpoint} failed`,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- Polling ---

  async getUpdates(
    updatesBuf: string,
    signal?: AbortSignal
  ): Promise<IlinkGetUpdatesResponse> {
    try {
      return await this.post<IlinkGetUpdatesResponse>(
        "ilink/bot/getupdates",
        { get_updates_buf: updatesBuf },
        GETUPDATES_LONG_POLL_TIMEOUT_MS,
        signal
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: updatesBuf };
      }
      throw error;
    }
  }

  // --- Send ---

  buildSendMessageBody(params: SendMessageParams) {
    const items: IlinkMessageItem[] = [];

    if (params.text) {
      items.push({
        type: MessageItemType.TEXT,
        text_item: { text: params.text },
      });
    }

    if (params.images) {
      for (const img of params.images) {
        items.push({
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: img.encryptQueryParam,
              aes_key: img.aesKeyB64,
              encrypt_type: 1,
            },
            mid_size: img.ciphertextSize,
          },
        });
      }
    }

    return {
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: crypto.randomBytes(8).toString("hex"),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: items,
        context_token: params.contextToken ?? "",
      },
    };
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const body = this.buildSendMessageBody(params);
    try {
      const response = await this.post<{ ret?: number; errcode?: number }>(
        "ilink/bot/sendmessage",
        body
      );
      this.logger?.info("iLink sendMessage succeeded", {
        endpoint: "ilink/bot/sendmessage",
        toUserId: params.toUserId,
        ret: response.ret,
        errcode: response.errcode,
        contextTokenUsed: Boolean(params.contextToken),
        retriedWithoutContextToken: false,
      });
      return { retriedWithoutContextToken: false };
    } catch (error) {
      if (
        params.contextToken &&
        error instanceof IlinkBusinessError &&
        isStaleContextTokenError(error)
      ) {
        this.logger?.warn(
          "iLink sendMessage context token appears stale; retrying without it",
          {
            endpoint: error.endpoint,
            ret: error.ret,
            errcode: error.errcode,
            errmsg: sanitizeIlinkMessage(error.errmsg),
          }
        );
        const response = await this.post<{ ret?: number; errcode?: number }>(
          "ilink/bot/sendmessage",
          this.buildSendMessageBody({ ...params, contextToken: undefined })
        );
        this.logger?.info("iLink sendMessage succeeded", {
          endpoint: "ilink/bot/sendmessage",
          toUserId: params.toUserId,
          ret: response.ret,
          errcode: response.errcode,
          contextTokenUsed: false,
          retriedWithoutContextToken: true,
        });
        return { retriedWithoutContextToken: true };
      }
      throw error;
    }
  }

  // --- Typing ---

  async getConfig(
    userId: string,
    contextToken?: string
  ): Promise<IlinkGetConfigResponse> {
    return this.post<IlinkGetConfigResponse>("ilink/bot/getconfig", {
      ilink_user_id: userId,
      context_token: contextToken ?? "",
    });
  }

  async sendTyping(
    userId: string,
    typingTicket: string,
    status: 1 | 0 = 1
  ): Promise<void> {
    await this.post("ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
    });
  }

  // --- QR Login ---

  async fetchQrCode(): Promise<IlinkQrCodeResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      this.logger?.warn("Failed to fetch QR code", {
        status: response.status,
        body: body.slice(0, 200),
      });
      throw new AuthenticationError(
        "wechat-acp",
        `Failed to fetch QR code: ${response.status} ${body}`
      );
    }
    return (await response.json()) as IlinkQrCodeResponse;
  }

  async pollQrStatus(qrcode: string): Promise<IlinkQrStatusResponse> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      QR_LONG_POLL_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        headers: { "iLink-App-ClientVersion": "1" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "(unreadable)");
        throw new AuthenticationError(
          "wechat-acp",
          `QR status poll failed: ${response.status} ${body}`
        );
      }
      return (await response.json()) as IlinkQrStatusResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { status: "wait" };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- Media Upload ---

  async getUploadUrl(params: {
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawSize: number;
    rawFileMd5: string;
    fileSize: number;
    aesKeyHex: string;
  }): Promise<IlinkUploadUrlResponse> {
    return this.post<IlinkUploadUrlResponse>("ilink/bot/getuploadurl", {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawSize,
      rawfilemd5: params.rawFileMd5,
      filesize: params.fileSize,
      aeskey: params.aesKeyHex,
      no_need_thumb: true,
    });
  }

  async uploadToCdn(
    uploadUrl: string,
    encryptedData: Buffer
  ): Promise<string> {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(encryptedData.length),
      },
      body: new Uint8Array(encryptedData),
    });

    if (response.status >= 400 && response.status < 500) {
      const errMsg =
        response.headers.get("x-error-message") ??
        (await response.text().catch(() => "")).slice(0, 200);
      this.logger?.warn("CDN upload client error", {
        status: response.status,
        error: errMsg,
      });
      throw new NetworkError(
        "wechat-acp",
        `CDN upload client error ${response.status}: ${errMsg}`
      );
    }
    if (!response.ok) {
      this.logger?.warn("CDN upload failed", { status: response.status });
      throw new NetworkError(
        "wechat-acp",
        `CDN upload failed: ${response.status}`
      );
    }

    const encryptedParam = response.headers.get("x-encrypted-param");
    if (!encryptedParam) {
      throw new NetworkError(
        "wechat-acp",
        "CDN response missing x-encrypted-param header"
      );
    }
    return encryptedParam;
  }

  // --- Media Download ---

  async downloadFromCdn(encryptQueryParam: string): Promise<Buffer> {
    const url = `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      this.logger?.warn("CDN download failed", { status: response.status });
      throw new NetworkError(
        "wechat-acp",
        `CDN download failed: ${response.status}`
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function isIlinkBusinessFailure(response: {
  ret?: number;
  errcode?: number;
}): boolean {
  return (
    (response.ret != null && response.ret !== 0) ||
    (response.errcode != null && response.errcode !== 0)
  );
}

function isStaleContextTokenError(error: IlinkBusinessError): boolean {
  if (error.ret !== -2) return false;
  const errmsg = String(error.errmsg ?? "").trim().toLowerCase();
  return (
    errmsg === "" ||
    errmsg === "unknown" ||
    errmsg === "null" ||
    errmsg.includes("context_token") ||
    errmsg.includes("context token")
  );
}

function sanitizeIlinkMessage(message: string | undefined): string | undefined {
  if (message == null) return undefined;
  return message.slice(0, 200);
}
