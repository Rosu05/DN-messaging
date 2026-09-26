const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const { db, initializeDatabase } = require('./db');

const app = express();
const httpServer = http.createServer(app);
const allowedOrigins = (process.env.CLIENT_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    methods: ['GET', 'POST']
  }
});
let redisClients = [];

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be configured with at least 32 characters in production');
}
const authSecret = process.env.SESSION_SECRET || 'local-development-secret-change-me';
const publicDirectory = path.join(__dirname, 'public');
const uploadDirectory = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true });
const upload = multer({
  dest: uploadDirectory,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, /^(image\/(jpeg|png|gif|webp)|audio\/(mpeg|wav|ogg|webm)|video\/(mp4|webm)|text\/plain|application\/pdf)$/.test(file.mimetype))
});

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  if (process.env.NODE_ENV === 'production') response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use((request, response, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && request.path.startsWith('/api/')) {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return response.status(403).json({ error: 'Origin is not allowed' });
  }
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(publicDirectory));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
const searchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

function getTokenFromCookie(request) {
  const match = request.headers.cookie?.match(/(?:^|; )auth_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function verifyToken(token) {
  return token ? jwt.verify(token, authSecret) : null;
}

function setAuthCookie(response, user) {
  const token = jwt.sign({ userId: user.id }, authSecret, { expiresIn: '7d' });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `auth_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
}

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email };
}

function directRoomId(firstUserId, secondUserId) {
  return `direct:${[firstUserId, secondUserId].sort().join(':')}`;
}

function isUserOnline(userId) {
  return [...io.sockets.sockets.values()].some((socket) => socket.data.userId === userId);
}

function contactView(user) {
  return { id: user.id, username: user.username, online: isUserOnline(user.id) };
}

function uploadFilenameFromUrl(url) {
  const match = typeof url === 'string' ? url.match(/^\/uploads\/([A-Za-z0-9._-]+)$/) : null;
  return match ? match[1] : null;
}

function authenticatedUserId(request) {
  try {
    return verifyToken(getTokenFromCookie(request))?.userId || null;
  } catch (_error) {
    return null;
  }
}

app.post('/api/auth/register', authLimiter, async (request, response) => {
  const { username, email, password, confirmPassword } = request.body || {};
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!db) return response.status(503).json({ error: 'Database is not configured' });
  if (!/^[a-zA-Z0-9_ ]{3,40}$/.test(normalizedUsername)) {
    return response.status(400).json({ error: 'Username must be 3-40 characters' });
  }
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    return response.status(400).json({ error: 'Enter a valid email' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return response.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (password !== confirmPassword) {
    return response.status(400).json({ error: 'Passwords do not match' });
  }

  try {
    const user = { id: crypto.randomUUID(), username: normalizedUsername, email: normalizedEmail };
    const passwordHash = await bcrypt.hash(password, 12);
    await db.execute({
      sql: 'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
      args: [user.id, user.username, user.email, passwordHash]
    });
    setAuthCookie(response, user);
    response.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT' || error.message?.includes('UNIQUE')) {
      return response.status(409).json({ error: 'Username or email is already registered' });
    }
    response.status(500).json({ error: 'Could not create account' });
  }
});

app.post('/api/auth/login', authLimiter, async (request, response) => {
  const { username, password } = request.body || {};
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  if (!db) return response.status(503).json({ error: 'Database is not configured' });

  try {
    const result = await db.execute({ sql: 'SELECT id, username, email, password_hash FROM users WHERE username = ?', args: [normalizedUsername] });
    const user = result.rows[0];
    const validPassword = user && typeof password === 'string' ? await bcrypt.compare(password, user.password_hash) : false;
    if (!validPassword) return response.status(401).json({ error: 'Email or password is incorrect' });
    const safeUser = { id: user.id, username: user.username, email: user.email };
    setAuthCookie(response, safeUser);
    response.json({ user: publicUser(safeUser) });
  } catch (_error) {
    response.status(500).json({ error: 'Could not log in' });
  }
});

app.get('/api/auth/me', async (request, response) => {
  try {
    const payload = verifyToken(getTokenFromCookie(request));
    if (!payload || !db) return response.json({ authenticated: false, user: null });
    const result = await db.execute({ sql: 'SELECT id, username, email FROM users WHERE id = ?', args: [payload.userId] });
    const user = result.rows[0];
    response.json({ authenticated: Boolean(user), user: user ? publicUser(user) : null });
  } catch (_error) {
    response.json({ authenticated: false, user: null });
  }
});

app.post('/api/auth/logout', (_request, response) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `auth_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  response.status(204).end();
});

app.patch('/api/profile', async (request, response) => {
  const userId = authenticatedUserId(request);
  const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (!/^[a-zA-Z0-9_ ]{3,40}$/.test(username) || !/^\S+@\S+\.\S+$/.test(email)) return response.status(400).json({ error: 'Invalid profile details' });
  try {
    await db.execute({ sql: 'UPDATE users SET username = ?, email = ? WHERE id = ?', args: [username, email, userId] });
    response.json({ user: { id: userId, username, email } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT' || error.message?.includes('UNIQUE')) return response.status(409).json({ error: 'Username or email is already in use' });
    response.status(500).json({ error: 'Could not update profile' });
  }
});

app.patch('/api/profile/password', authLimiter, async (request, response) => {
  const userId = authenticatedUserId(request);
  const { currentPassword, newPassword, confirmPassword } = request.body || {};
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword !== confirmPassword) {
    return response.status(400).json({ error: 'Invalid password details' });
  }
  try {
    const result = await db.execute({ sql: 'SELECT password_hash AS passwordHash FROM users WHERE id = ?', args: [userId] });
    if (!result.rows[0] || !(await bcrypt.compare(currentPassword, result.rows[0].passwordHash))) {
      return response.status(401).json({ error: 'Current password is incorrect' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [passwordHash, userId] });
    response.status(204).end();
  } catch (_error) {
    response.status(500).json({ error: 'Could not update password' });
  }
});

app.get('/api/contacts', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const friends = await db.execute({
      sql: `SELECT u.id, u.username FROM users u
        INNER JOIN friendships f ON f.friend_id = u.id
        WHERE f.user_id = ? AND f.status = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_id = ? AND b.blocked_user_id = u.id) OR (b.user_id = u.id AND b.blocked_user_id = ?))
        ORDER BY u.username`, args: [userId, userId, userId]
    });
    const suggestions = await db.execute({
      sql: `SELECT u.id, u.username FROM users u
        WHERE u.id <> ? AND NOT EXISTS (
          SELECT 1 FROM friendships f WHERE (f.user_id = ? AND f.friend_id = u.id)
          OR (f.user_id = u.id AND f.friend_id = ?)
        ) AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_id = ? AND b.blocked_user_id = u.id) OR (b.user_id = u.id AND b.blocked_user_id = ?))
        ORDER BY u.username`, args: [userId, userId, userId, userId, userId]
    });
    const requests = await db.execute({
      sql: `SELECT u.id, u.username FROM users u
        INNER JOIN friendships f ON f.user_id = u.id
        WHERE f.friend_id = ? AND f.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_id = ? AND b.blocked_user_id = u.id) OR (b.user_id = u.id AND b.blocked_user_id = ?))
        ORDER BY f.created_at DESC`, args: [userId, userId, userId]
    });
    response.json({ friends: friends.rows.map(contactView), suggestions: suggestions.rows.map(contactView), requests: requests.rows.map(contactView), requestCount: requests.rows.length });
  } catch (_error) {
    response.status(500).json({ error: 'Could not load contacts' });
  }
});

app.get('/api/conversations', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const result = await db.execute({
      sql: `SELECT u.id, u.username,
          (SELECT m.text FROM messages m WHERE m.room_id = 'direct:' || CASE WHEN ? < u.id THEN ? || ':' || u.id ELSE u.id || ':' || ? END AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_text,
          (SELECT m.created_at FROM messages m WHERE m.room_id = 'direct:' || CASE WHEN ? < u.id THEN ? || ':' || u.id ELSE u.id || ':' || ? END AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_created_at,
          (SELECT COUNT(*) FROM messages m WHERE m.room_id = 'direct:' || CASE WHEN ? < u.id THEN ? || ':' || u.id ELSE u.id || ':' || ? END AND m.user_id <> ? AND m.read_at IS NULL) AS unread_count
        FROM users u
        INNER JOIN friendships f ON f.friend_id = u.id
        WHERE f.user_id = ? AND f.status = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_id = ? AND b.blocked_user_id = u.id) OR (b.user_id = u.id AND b.blocked_user_id = ?))
        ORDER BY u.username`,
      args: [userId, userId, userId, userId, userId, userId, userId, userId, userId, userId, userId, userId, userId]
    });
    const rows = result.rows.map((row) => ({
      ...contactView(row),
      lastText: row.last_text || '',
      lastCreatedAt: row.last_created_at || null,
      unreadCount: Number(row.unread_count || 0)
    }));
    rows.sort((first, second) => (second.lastCreatedAt || '').localeCompare(first.lastCreatedAt || ''));
    response.json({ conversations: rows });
  } catch (_error) {
    response.status(500).json({ error: 'Could not load conversations' });
  }
});

app.post('/api/conversations/:friendId/read', async (request, response) => {
  const userId = authenticatedUserId(request);
  const friendId = request.params.friendId;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    await db.execute({ sql: "UPDATE messages SET read_at = datetime('now') WHERE room_id = ? AND user_id <> ? AND read_at IS NULL", args: [directRoomId(userId, friendId), userId] });
    response.json({ read: true });
  } catch (_error) {
    response.status(500).json({ error: 'Could not mark messages as read' });
  }
});

app.get('/api/messages/search', searchLimiter, async (request, response) => {
  const userId = authenticatedUserId(request);
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (query.length < 2 || query.length > 100) return response.status(400).json({ error: 'Search query must be 2-100 characters' });
  try {
    const result = await db.execute({
      sql: `SELECT m.id, m.room_id AS roomId, m.user_id AS senderId, u.username AS senderName,
        m.text, m.created_at AS timestamp
        FROM messages m INNER JOIN users u ON u.id = m.user_id
        INNER JOIN room_members rm ON rm.room_id = m.room_id
        WHERE rm.user_id = ? AND m.deleted_at IS NULL AND m.text LIKE ?
        ORDER BY m.created_at DESC LIMIT 50`,
      args: [userId, `%${query}%`]
    });
    response.json({ messages: result.rows });
  } catch (_error) {
    response.status(500).json({ error: 'Could not search messages' });
  }
});

app.get('/api/conversations/:friendId/messages', async (request, response) => {
  const userId = authenticatedUserId(request);
  const friendId = request.params.friendId;
  const limit = Math.min(Math.max(Number.parseInt(request.query.limit, 10) || 50, 1), 100);
  const before = typeof request.query.before === 'string' ? request.query.before : null;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const membership = await db.execute({
      sql: `SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
      args: [userId, friendId]
    });
    if (!membership.rows.length) return response.status(403).json({ error: 'Conversation access denied' });
    const result = await db.execute({
      sql: `SELECT m.id, m.user_id AS senderId, u.username AS senderName, m.text,
        m.attachment_json AS attachmentJson, m.reply_to AS replyTo, m.reaction_json AS reactionJson,
        m.delivered_at AS deliveredAt, m.read_at AS readAt, m.edited_at AS editedAt,
        m.deleted_at AS deletedAt, m.created_at AS timestamp
        FROM messages m INNER JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ? AND m.deleted_at IS NULL ${before ? 'AND m.created_at < ?' : ''}
        ORDER BY m.created_at DESC LIMIT ?`,
      args: before ? [directRoomId(userId, friendId), before, limit] : [directRoomId(userId, friendId), limit]
    });
    response.json({ messages: result.rows.reverse(), hasMore: result.rows.length === limit });
  } catch (_error) {
    response.status(500).json({ error: 'Could not load messages' });
  }
});

app.post('/api/uploads', uploadLimiter, (request, response, next) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  request.userId = userId;
  next();
}, upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'A supported file is required' });
  await db.execute({
    sql: 'INSERT INTO uploads (filename, user_id, original_name, mimetype, size) VALUES (?, ?, ?, ?, ?)',
    args: [request.file.filename, request.userId, request.file.originalname, request.file.mimetype, request.file.size]
  });
  response.status(201).json({
    url: `/uploads/${request.file.filename}`,
    name: request.file.originalname,
    type: request.file.mimetype,
    size: request.file.size
  });
});

app.get('/uploads/:filename', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).end();
  const filename = request.params.filename;
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return response.status(404).end();
  const result = await db.execute({
    sql: `SELECT 1 FROM uploads u
      WHERE u.filename = ? AND (u.user_id = ? OR EXISTS (
        SELECT 1 FROM messages m INNER JOIN room_members rm ON rm.room_id = m.room_id
        WHERE rm.user_id = ? AND m.attachment_json LIKE '%' || ? || '%'
      ))`,
    args: [filename, userId, userId, filename]
  });
  if (!result.rows.length) return response.status(404).end();
  response.sendFile(path.join(uploadDirectory, filename));
});

app.post('/api/contacts/:friendId', async (request, response) => {
  const userId = authenticatedUserId(request);
  const friendId = request.params.friendId;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (userId === friendId) return response.status(400).json({ error: 'You cannot add yourself' });
  try {
    await db.execute({ sql: 'INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?, ?, ?)', args: [userId, friendId, 'pending'] });
    response.status(201).json({ requested: true });
  } catch (_error) {
    response.status(500).json({ error: 'Could not add friend' });
  }
});

app.post('/api/contacts/:friendId/accept', async (request, response) => {
  const userId = authenticatedUserId(request);
  const friendId = request.params.friendId;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    await db.batch([
      { sql: "UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ? AND status = 'pending'", args: [friendId, userId] },
      { sql: "INSERT OR REPLACE INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'accepted')", args: [userId, friendId] }
    ], 'write');
    response.json({ accepted: true });
  } catch (_error) {
    response.status(500).json({ error: 'Could not accept friend request' });
  }
});

app.delete('/api/contacts/:friendId/request', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  await db.execute({ sql: 'DELETE FROM friendships WHERE user_id = ? AND friend_id = ? AND status = ?', args: [request.params.friendId, userId, 'pending'] });
  response.status(204).end();
});

app.delete('/api/contacts/:friendId/cancel', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  await db.execute({ sql: 'DELETE FROM friendships WHERE user_id = ? AND friend_id = ? AND status = ?', args: [userId, request.params.friendId, 'pending'] });
  response.status(204).end();
});

app.get('/api/blocked', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  const result = await db.execute({
    sql: `SELECT u.id, u.username, u.email FROM blocked_users b INNER JOIN users u ON u.id = b.blocked_user_id WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    args: [userId]
  });
  response.json({ blocked: result.rows });
});

app.delete('/api/contacts/:friendId', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  await db.batch([
    { sql: 'DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', args: [userId, request.params.friendId, request.params.friendId, userId] }
  ], 'write');
  response.status(204).end();
});

app.post('/api/contacts/:friendId/block', async (request, response) => {
  const userId = authenticatedUserId(request);
  const friendId = request.params.friendId;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (userId === friendId) return response.status(400).json({ error: 'You cannot block yourself' });
  await db.batch([
    { sql: 'INSERT OR IGNORE INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)', args: [userId, friendId] },
    { sql: 'DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', args: [userId, friendId, friendId, userId] }
  ], 'write');
  response.status(204).end();
});

app.delete('/api/contacts/:friendId/block', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  await db.execute({ sql: 'DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?', args: [userId, request.params.friendId] });
  response.status(204).end();
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'instant-messaging-networking-demo', timestamp: new Date().toISOString() });
});
app.get('/ready', async (_request, response) => {
  if (!db) return response.status(503).json({ status: 'not-ready', database: 'not-configured' });
  try {
    await db.execute('SELECT 1');
    response.json({ status: 'ready', database: 'ok' });
  } catch (_error) {
    response.status(503).json({ status: 'not-ready', database: 'unavailable' });
  }
});
app.get('/api/webrtc-config', (request, response) => {
  if (!authenticatedUserId(request)) return response.status(401).json({ error: 'Authentication required' });
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_SERVER_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_SERVER_URL.split(',').map((url) => url.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  response.json({ iceServers });
});
app.get('/api/call-history', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  const result = await db.execute({
    sql: `SELECT c.id, c.mode, c.status, c.started_at AS startedAt, c.ended_at AS endedAt,
      u.username AS otherUsername FROM calls c INNER JOIN users u ON u.id = CASE WHEN c.caller_id = ? THEN c.callee_id ELSE c.caller_id END
      WHERE c.caller_id = ? OR c.callee_id = ? ORDER BY c.started_at DESC LIMIT 100`,
    args: [userId, userId, userId]
  });
  response.json({ calls: result.rows });
});
app.get('*', (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

app.use((error, _request, response, next) => {
  if (error instanceof multer.MulterError || error.message === 'Unexpected field') return response.status(400).json({ error: 'A supported file is required' });
  next(error);
});

// Socket.io uses a persistent TCP connection (normally upgraded to WebSocket)
// to transport chat messages and signaling packets with low latency.
io.use((socket, next) => {
  try {
    const cookie = socket.handshake.headers.cookie || '';
    const match = cookie.match(/(?:^|; )auth_token=([^;]+)/);
    const payload = verifyToken(match ? decodeURIComponent(match[1]) : null);
    if (!payload) return next(new Error('Authentication required'));
    socket.data.userId = payload.userId;
    next();
  } catch (_error) {
    next(new Error('Authentication required'));
  }
});

io.on('connection', (socket) => {
  const roomForSocket = () => socket.data.roomId;
  socket.data.messageWindow = [];

  socket.on('join-room', async ({ peerId, selectionToken }) => {
    if (typeof peerId !== 'string' || peerId === socket.data.userId) return;
    const membership = await db?.execute({
      sql: `SELECT 1 FROM friendships f WHERE f.user_id = ? AND f.friend_id = ? AND f.status = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_id = ? AND b.blocked_user_id = ?) OR (b.user_id = ? AND b.blocked_user_id = ?))`,
      args: [socket.data.userId, peerId, socket.data.userId, peerId, peerId, socket.data.userId]
    });
    if (db && !membership.rows.length) return socket.emit('chat-error', { message: 'You can only message accepted friends' });
    const safeRoomId = directRoomId(socket.data.userId, peerId);
    let safeUsername = 'User';
    if (db) {
      const result = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [socket.data.userId] });
      safeUsername = result.rows[0]?.username || safeUsername;
      await db.execute({ sql: 'INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)', args: [safeRoomId, 'Direct conversation'] });
      await db.batch([
        { sql: 'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', args: [safeRoomId, socket.data.userId] },
        { sql: 'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', args: [safeRoomId, peerId] }
      ], 'write');
    }

    if (socket.data.roomId) socket.leave(socket.data.roomId);
    socket.join(safeRoomId);
    socket.data.roomId = safeRoomId;
    socket.data.username = safeUsername;

    const members = io.sockets.adapter.rooms.get(safeRoomId);
    socket.emit('room-joined', {
      roomId: safeRoomId,
      participantCount: members ? members.size : 1,
      selectionToken
    });
    if (db) {
      const history = await db.execute({
        sql: `SELECT m.id, m.user_id AS senderId, u.username AS senderName, m.text, m.attachment_json AS attachmentJson,
          m.reply_to AS replyTo, m.reaction_json AS reactionJson, m.delivered_at AS deliveredAt, m.read_at AS readAt,
          m.edited_at AS editedAt, m.deleted_at AS deletedAt, m.created_at AS timestamp
          FROM messages m INNER JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 200`,
        args: [safeRoomId]
      });
      await db.execute({ sql: "UPDATE messages SET delivered_at = COALESCE(delivered_at, datetime('now')) WHERE room_id = ? AND user_id <> ?", args: [safeRoomId, socket.data.userId] });
      socket.emit('chat-history', { messages: history.rows, selectionToken });
    }
    socket.to(safeRoomId).emit('peer-joined', { username: safeUsername });
  });

  socket.on('chat-message', async ({ text, attachment, replyTo }) => {
    const now = Date.now();
    socket.data.messageWindow = socket.data.messageWindow.filter((sentAt) => now - sentAt < 60_000);
    if (socket.data.messageWindow.length >= 60) return socket.emit('chat-error', { message: 'ส่งข้อความเร็วเกินไป กรุณารอสักครู่' });
    socket.data.messageWindow.push(now);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return;

    const message = {
      id: `${socket.id}-${Date.now()}`,
      senderId: socket.data.userId,
      senderName: socket.data.username || 'Guest',
      text: text.trim(),
      timestamp: new Date().toISOString()
    };
    if (!socket.data.roomId) return;
    if (attachment) {
      const filename = uploadFilenameFromUrl(attachment.url);
      const uploadResult = filename && db ? await db.execute({ sql: 'SELECT original_name AS name, mimetype AS type, size FROM uploads WHERE filename = ? AND user_id = ?', args: [filename, socket.data.userId] }) : null;
      if (!uploadResult?.rows.length) return socket.emit('chat-error', { message: 'Attachment is invalid or expired' });
      message.attachment = { url: `/uploads/${filename}`, ...uploadResult.rows[0] };
    }
    let safeReplyTo = null;
    if (typeof replyTo === 'string' && db) {
      const replyResult = await db.execute({ sql: 'SELECT id FROM messages WHERE id = ? AND room_id = ?', args: [replyTo, roomForSocket()] });
      if (replyResult.rows.length) safeReplyTo = replyTo;
    }
    if (safeReplyTo) message.replyTo = safeReplyTo;
    if (db) db.execute({ sql: 'INSERT INTO messages (id, room_id, user_id, text, attachment_json, reply_to, delivered_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))', args: [message.id, roomForSocket(), socket.data.userId, message.text, message.attachment ? JSON.stringify(message.attachment) : null, safeReplyTo] }).catch(() => {});
    io.to(roomForSocket()).emit('chat-message', message);
  });

  socket.on('react-message', async ({ messageId, emoji }) => {
    const allowedEmojis = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
    if (!db || !socket.data.roomId || typeof messageId !== 'string' || !allowedEmojis.includes(emoji)) return;
    const messageResult = await db.execute({ sql: 'SELECT reaction_json AS reactions FROM messages WHERE id = ? AND room_id = ?', args: [messageId, roomForSocket()] });
    if (!messageResult.rows.length) return;
    let reactions = {};
    try { reactions = JSON.parse(messageResult.rows[0].reactions || '{}'); } catch (_error) {}
    if (reactions[socket.data.userId] === emoji) delete reactions[socket.data.userId];
    else reactions[socket.data.userId] = emoji;
    await db.execute({ sql: 'UPDATE messages SET reaction_json = ? WHERE id = ? AND room_id = ?', args: [JSON.stringify(reactions), messageId, roomForSocket()] });
    io.to(roomForSocket()).emit('message-reaction', { messageId, reactions });
  });

  socket.on('typing', ({ active }) => {
    if (!socket.data.roomId) return;
    socket.to(roomForSocket()).emit('typing', { active: Boolean(active), username: socket.data.username || 'เพื่อน' });
  });

  socket.on('edit-message', async ({ messageId, text }) => {
    if (typeof messageId !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 2000 || !socket.data.roomId || !db) return;
    const updatedAt = new Date().toISOString();
    const result = await db.execute({ sql: 'UPDATE messages SET text = ?, edited_at = ? WHERE id = ? AND user_id = ? AND room_id = ?', args: [text.trim(), updatedAt, messageId, socket.data.userId, roomForSocket()] });
    if (result.rowsAffected) io.to(roomForSocket()).emit('message-edited', { messageId, text: text.trim(), editedAt: updatedAt });
  });

  socket.on('delete-message', async ({ messageId }) => {
    if (typeof messageId !== 'string' || !socket.data.roomId || !db) return;
    const deletedAt = new Date().toISOString();
    const result = await db.execute({ sql: 'UPDATE messages SET text = ?, attachment_json = NULL, deleted_at = ? WHERE id = ? AND user_id = ? AND room_id = ?', args: ['ข้อความถูกลบแล้ว', deletedAt, messageId, socket.data.userId, roomForSocket()] });
    if (result.rowsAffected) io.to(roomForSocket()).emit('message-deleted', { messageId, deletedAt });
  });

  socket.on('call-user', ({ mode }) => {
    if (!socket.data.roomId) return;
    const target = [...(io.sockets.adapter.rooms.get(roomForSocket()) || [])].find((socketId) => socketId !== socket.id);
    const targetSocket = target ? io.sockets.sockets.get(target) : null;
    if (!targetSocket || targetSocket.data.callId) return socket.emit('call-busy');
    socket.data.callId = crypto.randomUUID();
    if (db) db.execute({ sql: 'INSERT INTO calls (id, room_id, caller_id, callee_id, mode, status) VALUES (?, ?, ?, ?, ?, ?)', args: [socket.data.callId, roomForSocket(), socket.data.userId, targetSocket.data.userId, mode === 'audio' ? 'audio' : 'video', 'ringing'] }).catch(() => {});
    socket.to(roomForSocket()).emit('incoming-call', {
      callerId: socket.id,
      callId: socket.data.callId,
      callerName: socket.data.username || 'Guest',
      mode: mode === 'audio' ? 'audio' : 'video'
    });
  });

  for (const [eventName, status] of [['call-accepted', 'answered'], ['call-rejected', 'rejected']]) {
    socket.on(eventName, ({ targetId, callId }) => {
      if (typeof targetId !== 'string' || typeof callId !== 'string' || !socket.data.roomId) return;
      const targetSocket = io.sockets.sockets.get(targetId);
      if (!targetSocket || targetSocket.data.roomId !== socket.data.roomId) return;
      targetSocket.data.callId = callId;
      if (db) db.execute({ sql: 'UPDATE calls SET status = ? WHERE id = ? AND callee_id = ? AND status = \'ringing\'', args: [status, callId, socket.data.userId] }).catch(() => {});
      targetSocket.emit(eventName, { senderId: socket.id });
    });
  }

  // These signaling packets carry SDP and ICE metadata only. WebRTC media does
  // not pass through this Node process after the peer connection is established.
  for (const eventName of ['webrtc-offer', 'webrtc-answer', 'ice-candidate']) {
    socket.on(eventName, ({ targetId, ...payload }) => {
      if (typeof targetId !== 'string' || !socket.data.roomId) return;
      const targetSocket = io.sockets.sockets.get(targetId);
      if (!targetSocket || targetSocket.data.roomId !== socket.data.roomId) return;
      targetSocket.emit(eventName, { senderId: socket.id, ...payload });
    });
  }

  socket.on('end-call', () => {
    if (db && socket.data.callId) db.execute({ sql: "UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END, ended_at = datetime('now') WHERE id = ?", args: [socket.data.callId] }).catch(() => {});
    if (socket.data.roomId) socket.to(roomForSocket()).emit('call-ended');
    socket.data.callId = null;
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) socket.to(roomId).emit('peer-left');
    }
  });
});

async function startServer() {
  if (process.env.REDIS_URL) {
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisClients = [pubClient, subClient];
    console.log('Socket.io Redis adapter is enabled.');
  }
  await initializeDatabase();
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Networking demo is running on port ${port}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to initialize the database:', error);
    process.exit(1);
  });
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  await new Promise((resolve) => io.close(() => resolve()));
  await new Promise((resolve) => httpServer.close(() => resolve()));
  await Promise.all(redisClients.map((client) => client.quit().catch(() => {})));
  process.exit(0);
}

if (require.main === module) {
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, httpServer, io, startServer };
