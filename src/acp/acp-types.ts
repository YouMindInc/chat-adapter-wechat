// --- ilink API types ---

export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { FINISH: 2 } as const;
// 上传协议的类型值与消息 item 的类型值不同。
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3 } as const;
export const TypingStatus = { START: 1, STOP: 2 } as const;
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export interface IlinkCDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface IlinkTextItem {
  text?: string;
}

export interface IlinkImageItem {
  media?: IlinkCDNMedia;
  thumb_media?: IlinkCDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
}

export interface IlinkVoiceItem {
  media?: IlinkCDNMedia;
  text?: string;
}

export interface IlinkFileItem {
  media?: IlinkCDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface IlinkVideoItem {
  media?: IlinkCDNMedia;
  video_size?: number;
}

export interface IlinkRefMessage {
  message_item?: IlinkMessageItem;
  title?: string;
}

export interface IlinkMessageItem {
  type?: number;
  ref_msg?: IlinkRefMessage;
  text_item?: IlinkTextItem;
  image_item?: IlinkImageItem;
  voice_item?: IlinkVoiceItem;
  file_item?: IlinkFileItem;
  video_item?: IlinkVideoItem;
}

export interface IlinkMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: IlinkMessageItem[];
  context_token?: string;
  ref_msg?: IlinkRefMessage;
}

export interface IlinkGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
}

export interface IlinkGetConfigResponse {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface IlinkQrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface IlinkQrStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface IlinkUploadUrlResponse {
  upload_full_url?: string;
  upload_param?: string;
}

export interface AccountData {
  botToken: string;
  botId: string;
  userId: string;
  baseUrl: string;
  savedAt: number;
}

export interface PollState {
  updatesBuf: string;
  contextTokens: Record<string, string>;
  lastMessageId: number;
}
