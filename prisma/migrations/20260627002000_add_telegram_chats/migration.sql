CREATE TABLE IF NOT EXISTS telegram_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  username text,
  chat_type text NOT NULL DEFAULT 'unknown',
  broadcast_opt_out boolean NOT NULL DEFAULT false,
  blocked_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_chats_chat_id_unique UNIQUE (chat_id),
  CONSTRAINT telegram_chats_has_chat_id CHECK (chat_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_telegram_chats_last_seen_at
  ON telegram_chats (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_chats_username
  ON telegram_chats (username)
  WHERE username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_chats_broadcast_candidates
  ON telegram_chats (last_seen_at DESC)
  WHERE blocked_at IS NULL
    AND broadcast_opt_out = false;
