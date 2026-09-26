const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
const db = url ? createClient({ url, authToken }) : null;

async function initializeDatabase() {
  if (!db) {
    console.warn('Turso is not configured; database features are disabled.');
    return;
  }

  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      attachment_json TEXT,
      reply_to TEXT,
      reaction_json TEXT,
      delivered_at TEXT,
      read_at TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS friendships (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending', 'accepted')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, friend_id),
      CHECK (user_id <> friend_id)
    )`,
    `CREATE TABLE IF NOT EXISTS blocked_users (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, blocked_user_id),
      CHECK (user_id <> blocked_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('audio', 'video')),
      status TEXT NOT NULL CHECK (status IN ('ringing', 'answered', 'rejected', 'ended', 'missed')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS uploads (
      filename TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS messages_room_created_idx ON messages(room_id, created_at)',
    'CREATE INDEX IF NOT EXISTS uploads_user_idx ON uploads(user_id, created_at)'
  ], 'write');

  try {
    await db.execute("ALTER TABLE friendships ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'");
  } catch (error) {
    if (!error.message?.includes('duplicate column name')) throw error;
  }
  try {
    await db.execute('ALTER TABLE messages ADD COLUMN read_at TEXT');
  } catch (error) {
    if (!error.message?.includes('duplicate column name')) throw error;
  }
  try {
    await db.execute('ALTER TABLE messages ADD COLUMN attachment_json TEXT');
  } catch (error) {
    if (!error.message?.includes('duplicate column name')) throw error;
  }
  for (const column of ['edited_at', 'deleted_at']) {
    try {
      await db.execute(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
    } catch (error) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
  }
  for (const column of ['reply_to', 'reaction_json', 'delivered_at']) {
    try {
      await db.execute(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
    } catch (error) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
  }

  console.log('Turso database schema is ready.');
}

module.exports = { db, initializeDatabase };