export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type TelegramUpdate = {
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: TelegramUser;
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: TelegramUser;
    data?: string;
    message?: {
      chat: { id: number; type?: string };
      message_id: number;
    };
  };
};

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };
