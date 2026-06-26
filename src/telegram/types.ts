export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramUpdate = {
  message?: {
    message_id: number;
    chat: { id: number };
    from?: TelegramUser;
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: TelegramUser;
    data?: string;
    message?: {
      chat: { id: number };
      message_id: number;
    };
  };
};

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };
