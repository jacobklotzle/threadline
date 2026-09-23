import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. On Railway, add a Postgres service and reference its DATABASE_URL.");
  process.exit(1);
}

// Railway's internal network doesn't need SSL; its public proxy URL does.
const needsSsl = /proxy\.rlwy\.net|sslmode=require/.test(process.env.DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export const q = (text, params) => pool.query(text, params);

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title       text NOT NULL DEFAULT 'New conversation',
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );

    -- One table holds the trunk and every thread.
    --   thread_root_id IS NULL      -> message is on the main trunk
    --   thread_root_id = <trunk id> -> message is a reply in that message's thread
    --   kind = 'graft'              -> a thread summary merged into the trunk
    CREATE TABLE IF NOT EXISTS messages (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seq              bigserial,
      conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      thread_root_id   uuid REFERENCES messages(id) ON DELETE CASCADE,
      role             text NOT NULL CHECK (role IN ('user', 'assistant')),
      kind             text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'graft')),
      source_thread_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      content          text NOT NULL,
      usage            jsonb,
      created_at       timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS messages_conv_thread_seq
      ON messages (conversation_id, thread_root_id, seq);
  `);
}
