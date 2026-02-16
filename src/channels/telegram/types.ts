export interface TelegramApiResponseParameters {
  migrate_to_chat_id?: number;
  retry_after?: number;
}

export interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
}

export interface TelegramApiError {
  ok: false;
  error_code: number;
  description: string;
  parameters?: TelegramApiResponseParameters;
}

export type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiError;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
  custom_emoji_id?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  date: number;
  chat: TelegramChat;
  text?: string;
  entities?: TelegramMessageEntity[];
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  reply_to_message?: TelegramMessage;
  sticker?: { file_id: string; type?: string; emoji?: string };
  animation?: { file_id: string };
  video?: { file_id: string };
  video_note?: { file_id: string };
  contact?: { phone_number: string; first_name: string };
  location?: { latitude: number; longitude: number };
  venue?: { location: { latitude: number; longitude: number }; title: string };
  poll?: { id: string; question: string };
  dice?: { emoji: string; value: number };
  game?: { title: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramGetUpdatesOptions {
  timeoutSeconds?: number;
  limit?: number;
  allowedUpdates?: string[];
}

export interface TelegramSendMessageOptions {
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  replyToMessageId?: number;
}

export interface TelegramSendMediaOptions {
  caption?: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disableNotification?: boolean;
  replyToMessageId?: number;
}

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  pollTimeoutSeconds?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (delayMs: number) => Promise<void>;
  nowFn?: () => number;
}
