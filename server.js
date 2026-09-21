const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { db, initializeDatabase } = require('./db');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ['GET', 'POST'] }
});

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be configured in production');
}
const authSecret = process.env.SESSION_SECRET || 'local-development-secret-change-me';
const publicDirectory = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.static(publicDirectory));

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
  return { ...publicUser(user), online: isUserOnline(user.id) };
}

function authenticatedUserId(request) {
  try {
    return verifyToken(getTokenFromCookie(request))?.userId || null;
  } catch (_error) {
    return null;
  }
}

app.post('/api/auth/register', async (request, response) => {
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

app.post('/api/auth/login', async (request, response) => {
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
  response.setHeader('Set-Cookie', 'auth_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  response.status(204).end();
});

app.get('/api/contacts', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const friends = await db.execute({
      sql: `SELECT u.id, u.username, u.email FROM users u
        INNER JOIN friendships f ON f.friend_id = u.id
        WHERE f.user_id = ? AND f.status = 'accepted' ORDER BY u.username`, args: [userId]
    });
    const suggestions = await db.execute({
      sql: `SELECT u.id, u.username, u.email FROM users u
        WHERE u.id <> ? AND NOT EXISTS (
          SELECT 1 FROM friendships f WHERE (f.user_id = ? AND f.friend_id = u.id)
          OR (f.user_id = u.id AND f.friend_id = ?)
        ) ORDER BY u.username`, args: [userId, userId, userId]
    });
    const requests = await db.execute({
      sql: `SELECT u.id, u.username, u.email FROM users u
        INNER JOIN friendships f ON f.user_id = u.id
        WHERE f.friend_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`, args: [userId]
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
      sql: `SELECT u.id, u.username, u.email FROM users u
        INNER JOIN friendships f ON f.friend_id = u.id
        WHERE f.user_id = ? AND f.status = 'accepted' ORDER BY u.username`,
      args: [userId]
    });
    const rows = [];
    for (const row of result.rows) {
      const roomId = directRoomId(userId, row.id);
      const latest = await db.execute({ sql: 'SELECT text AS last_text, created_at AS last_created_at FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 1', args: [roomId] });
      rows.push({ ...contactView(row), lastText: latest.rows[0]?.last_text || '', lastCreatedAt: latest.rows[0]?.last_created_at || null });
    }
    rows.sort((first, second) => (second.lastCreatedAt || '').localeCompare(first.lastCreatedAt || ''));
    response.json({ conversations: rows });
  } catch (_error) {
    response.status(500).json({ error: 'Could not load conversations' });
  }
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

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'instant-messaging-networking-demo', timestamp: new Date().toISOString() });
});
app.get('*', (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'index.html'));
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

  socket.on('join-room', async ({ peerId, selectionToken }) => {
    if (typeof peerId !== 'string' || peerId === socket.data.userId) return;
    const membership = await db?.execute({
      sql: `SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
      args: [socket.data.userId, peerId]
    });
    if (db && !membership.rows.length) return socket.emit('chat-error', { message: 'You can only message accepted friends' });
    const safeRoomId = directRoomId(socket.data.userId, peerId);
    let safeUsername = 'User';
    if (db) {
      const result = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [socket.data.userId] });
      safeUsername = result.rows[0]?.username || safeUsername;
      await db.execute({ sql: 'INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)', args: [safeRoomId, 'Direct conversation'] });
      await db.execute({ sql: 'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', args: [safeRoomId, socket.data.userId] });
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
        sql: `SELECT m.id, m.user_id AS senderId, u.username AS senderName, m.text, m.created_at AS timestamp
          FROM messages m INNER JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.created_at ASC LIMIT 200`,
        args: [safeRoomId]
      });
      socket.emit('chat-history', { messages: history.rows, selectionToken });
    }
    socket.to(safeRoomId).emit('peer-joined', { username: safeUsername });
  });

  socket.on('chat-message', ({ roomId, text }) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return;

    const message = {
      id: `${socket.id}-${Date.now()}`,
      senderId: socket.data.userId,
      senderName: socket.data.username || 'Guest',
      text: text.trim(),
      timestamp: new Date().toISOString()
    };
    if (!socket.data.roomId) return;
    if (db) db.execute({ sql: 'INSERT INTO messages (id, room_id, user_id, text) VALUES (?, ?, ?, ?)', args: [message.id, roomForSocket(), socket.data.userId, message.text] }).catch(() => {});
    io.to(roomForSocket()).emit('chat-message', message);
  });

  socket.on('call-user', ({ mode }) => {
    socket.to(roomForSocket()).emit('incoming-call', {
      callerId: socket.id,
      callerName: socket.data.username || 'Guest',
      mode: mode === 'audio' ? 'audio' : 'video'
    });
  });

  // These signaling packets carry SDP and ICE metadata only. WebRTC media does
  // not pass through this Node process after the peer connection is established.
  for (const eventName of ['call-accepted', 'webrtc-offer', 'webrtc-answer', 'ice-candidate']) {
    socket.on(eventName, ({ targetId, ...payload }) => {
      if (typeof targetId === 'string') {
        io.to(targetId).emit(eventName, { senderId: socket.id, ...payload });
      }
    });
  }

  socket.on('end-call', () => {
    if (socket.data.roomId) socket.to(roomForSocket()).emit('call-ended');
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) socket.to(roomId).emit('peer-left');
    }
  });
});

async function startServer() {
  await initializeDatabase();
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Networking demo is running on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to initialize the database:', error);
  process.exit(1);
});
