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

async function createSystemMessage(roomId, userId, text) {
  const message = { id: crypto.randomUUID(), roomId, senderId: userId, senderName: 'ระบบ', text, timestamp: new Date().toISOString(), isSystem: true };
  await db.execute({ sql: 'INSERT INTO messages (id, room_id, user_id, text, is_system, delivered_at) VALUES (?, ?, ?, ?, 1, datetime(\'now\'))', args: [message.id, roomId, userId, text] });
  return message;
}

async function revokeConversation(firstUserId, secondUserId) {
  const roomId = directRoomId(firstUserId, secondUserId);
  io.to(roomId).emit('conversation-revoked');
  if (db) {
    await db.execute({
      sql: "UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END, ended_at = datetime('now') WHERE room_id = ? AND status IN ('ringing', 'answered')",
      args: [roomId]
    });
  }
  await io.in(roomId).socketsLeave(roomId);
}

function isUserOnline(userId) {
  return [...io.sockets.sockets.values()].some((socket) => socket.data.userId === userId);
}

function broadcastPresence(userId, online) {
  io.emit('presence-state', { userId, online, status: online ? 'online' : 'offline' });
}

function contactView(user) {
  return { id: user.id, username: user.username, online: isUserOnline(user.id), status: isUserOnline(user.id) ? 'online' : 'offline' };
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
    await db.execute({ sql: "INSERT OR IGNORE INTO group_invites (room_id, user_id, invited_by) VALUES ('group:main', ?, ?)", args: [user.id, user.id] });
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
    if (!validPassword) return response.status(401).json({ error: 'Username or password is incorrect' });
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
  const filterQuery = typeof request.query.q === 'string' ? request.query.q.trim().toLowerCase() : '';
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
    const filterPeople = (people) => filterQuery ? people.filter((person) => person.username.toLowerCase().includes(filterQuery)) : people;
    response.json({
      friends: filterPeople(friends.rows.map(contactView)),
      suggestions: filterPeople(suggestions.rows.map(contactView)),
      requests: filterPeople(requests.rows.map(contactView)),
      requestCount: requests.rows.length
    });
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

app.get('/api/groups', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const result = await db.execute({
      sql: `SELECT r.id, r.name, r.owner_id,
          (SELECT m.text FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_text,
          (SELECT m.created_at FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS last_created_at,
          (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count,
          (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id AND m.user_id <> ? AND m.is_system = 0 AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?)) AS unread_count
        FROM rooms r INNER JOIN room_members rm ON rm.room_id = r.id
        WHERE rm.user_id = ? AND r.id LIKE 'group:%'
        ORDER BY CASE WHEN r.id = 'group:main' THEN 0 ELSE 1 END, last_created_at DESC`,
      args: [userId, userId, userId]
    });
    response.json({ groups: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isGroup: true,
      ownerId: row.owner_id || null,
      memberCount: Number(row.member_count || 0),
      lastText: row.last_text || '',
      lastCreatedAt: row.last_created_at || null,
      unreadCount: Number(row.unread_count || 0)
    })) });
  } catch (_error) {
    response.status(500).json({ error: 'Could not load groups' });
  }
});

app.get('/api/group-invites', async (request, response) => {
  const userId = authenticatedUserId(request);
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const result = await db.execute({
      sql: `SELECT gi.room_id AS id, r.name, u.username AS inviter_name
        FROM group_invites gi INNER JOIN rooms r ON r.id = gi.room_id
        INNER JOIN users u ON u.id = gi.invited_by
        WHERE gi.user_id = ? AND gi.status = 'pending' AND r.id LIKE 'group:%'
        ORDER BY gi.created_at DESC`,
      args: [userId]
    });
    response.json({ invites: result.rows.map((row) => ({ id: row.id, name: row.name, inviterName: row.inviter_name })) });
  } catch (_error) {
    response.status(500).json({ error: 'Could not load group invitations' });
  }
});

async function groupMembership(groupId, userId) {
  return db.execute({
    sql: 'SELECT r.id, r.name, r.owner_id AS ownerId FROM rooms r INNER JOIN room_members rm ON rm.room_id = r.id WHERE r.id = ? AND rm.user_id = ? AND r.id LIKE \'group:%\'',
    args: [groupId, userId]
  });
}

app.get('/api/groups/:groupId', async (request, response) => {
  const userId = authenticatedUserId(request);
  const groupId = request.params.groupId;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const group = await groupMembership(groupId, userId);
    if (!group.rows.length) return response.status(403).json({ error: 'Group access denied' });
    const members = await db.execute({
      sql: `SELECT u.id, u.username, rm.joined_at AS joinedAt, u.id = ? AS isCurrentUser
        FROM room_members rm INNER JOIN users u ON u.id = rm.user_id
        WHERE rm.room_id = ? ORDER BY CASE WHEN u.id = ? THEN 0 ELSE 1 END, u.username`,
      args: [userId, groupId, group.rows[0].ownerId]
    });
    response.json({ group: { ...group.rows[0], isGroup: true, memberCount: members.rows.length, isOwner: group.rows[0].ownerId === userId, members: members.rows } });
  } catch (_error) {
    response.status(500).json({ error: 'Could not load group details' });
  }
});

app.post('/api/groups/:groupId/members', async (request, response) => {
  const userId = authenticatedUserId(request);
  const groupId = request.params.groupId;
  const memberIds = Array.isArray(request.body?.memberIds) ? [...new Set(request.body.memberIds.filter((id) => typeof id === 'string' && id !== userId))] : [];
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (!memberIds.length || memberIds.length > 100) return response.status(400).json({ error: 'Select at least one member' });
  try {
    const group = await groupMembership(groupId, userId);
    if (!group.rows.length) return response.status(403).json({ error: 'Group access denied' });
    if (group.rows[0].ownerId && group.rows[0].ownerId !== userId) return response.status(403).json({ error: 'Only the group owner can invite members' });
    const count = await db.execute({ sql: 'SELECT COUNT(*) AS member_count FROM room_members WHERE room_id = ?', args: [groupId] });
    const pending = await db.execute({ sql: "SELECT COUNT(*) AS invite_count FROM group_invites WHERE room_id = ? AND status = 'pending'", args: [groupId] });
    if (Number(count.rows[0]?.member_count || 0) + Number(pending.rows[0]?.invite_count || 0) + memberIds.length > 100) return response.status(409).json({ error: 'กลุ่มนี้รองรับสมาชิกและคำเชิญรวมกันไม่เกิน 100 คน' });
    for (const memberId of memberIds) {
      const friendship = await db.execute({ sql: "SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'", args: [userId, memberId] });
      if (!friendship.rows.length) return response.status(400).json({ error: 'You can only invite accepted friends' });
      await db.execute({ sql: "INSERT OR IGNORE INTO group_invites (room_id, user_id, invited_by, status) VALUES (?, ?, ?, 'pending')", args: [groupId, memberId, userId] });
    }
    response.status(201).json({ invited: memberIds.length });
  } catch (_error) {
    response.status(500).json({ error: 'Could not invite group members' });
  }
});

app.delete('/api/groups/:groupId/members/:memberId', async (request, response) => {
  const userId = authenticatedUserId(request);
  const groupId = request.params.groupId;
  const memberId = request.params.memberId;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  try {
    const group = await groupMembership(groupId, userId);
    if (!group.rows.length) return response.status(403).json({ error: 'Group access denied' });
    if (memberId !== userId && group.rows[0].ownerId && group.rows[0].ownerId !== userId) return response.status(403).json({ error: 'Only the group owner can remove members' });
    if (memberId === group.rows[0].ownerId) return response.status(400).json({ error: 'The owner cannot leave without transferring ownership' });
    const member = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [memberId] });
    const result = await db.execute({ sql: 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', args: [groupId, memberId] });
    if (!result.rowsAffected) return response.status(404).json({ error: 'Member not found' });
    const systemMessage = await createSystemMessage(groupId, userId, `${member.rows[0]?.username || 'สมาชิก'} ออกจากกลุ่มแล้ว`);
    io.to(groupId).emit('chat-message', systemMessage);
    const removedSockets = await io.in(groupId).fetchSockets();
    removedSockets.filter((candidate) => candidate.data.userId === memberId).forEach((candidate) => {
      candidate.emit('group-membership-revoked');
      candidate.leave(groupId);
      if (candidate.data.roomId === groupId) candidate.data.roomId = null;
    });
    response.json({ removed: true });
  } catch (_error) {
    response.status(500).json({ error: 'Could not remove group member' });
  }
});

app.post('/api/groups/:groupId/respond', async (request, response) => {
  const userId = authenticatedUserId(request);
  const groupId = request.params.groupId;
  const accepted = request.body?.accepted === true;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (!groupId.startsWith('group:')) return response.status(400).json({ error: 'Invalid group' });
  try {
    const invite = await db.execute({ sql: "SELECT 1 FROM group_invites WHERE room_id = ? AND user_id = ? AND status = 'pending'", args: [groupId, userId] });
    if (!invite.rows.length) return response.status(404).json({ error: 'Group invitation not found' });
    if (accepted) {
      const count = await db.execute({ sql: 'SELECT COUNT(*) AS member_count FROM room_members WHERE room_id = ?', args: [groupId] });
      if (Number(count.rows[0]?.member_count || 0) >= 100) return response.status(409).json({ error: 'กลุ่มนี้มีสมาชิกครบ 100 คนแล้ว' });
      await db.batch([
        { sql: 'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', args: [groupId, userId] },
        { sql: "UPDATE group_invites SET status = 'accepted', responded_at = datetime('now') WHERE room_id = ? AND user_id = ? AND status = 'pending'", args: [groupId, userId] }
      ], 'write');
      const user = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [userId] });
      const systemMessage = await createSystemMessage(groupId, userId, `${user.rows[0]?.username || 'สมาชิก'} เข้าร่วมกลุ่มแล้ว`);
      io.to(groupId).emit('chat-message', systemMessage);
    } else {
      await db.execute({ sql: "UPDATE group_invites SET status = 'declined', responded_at = datetime('now') WHERE room_id = ? AND user_id = ? AND status = 'pending'", args: [groupId, userId] });
    }
    response.json({ accepted });
  } catch (_error) {
    response.status(500).json({ error: 'Could not respond to group invitation' });
  }
});

app.post('/api/groups', async (request, response) => {
  const userId = authenticatedUserId(request);
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const memberIds = Array.isArray(request.body?.memberIds) ? [...new Set(request.body.memberIds.filter((id) => typeof id === 'string'))] : [];
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  if (name.length < 2 || name.length > 60) return response.status(400).json({ error: 'Group name must be 2-60 characters' });
  if (memberIds.length + 1 > 100) return response.status(400).json({ error: 'A group can have up to 100 members' });
  try {
    for (const memberId of memberIds) {
      const friendship = await db.execute({ sql: "SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'", args: [userId, memberId] });
      if (!friendship.rows.length) return response.status(400).json({ error: 'You can only invite accepted friends' });
    }
    const roomId = `group:${crypto.randomUUID()}`;
    await db.execute({ sql: 'INSERT INTO rooms (id, name, owner_id) VALUES (?, ?, ?)', args: [roomId, name, userId] });
    await db.batch([
      { sql: 'INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', args: [roomId, userId] },
      ...memberIds.map((memberId) => ({ sql: 'INSERT INTO group_invites (room_id, user_id, invited_by) VALUES (?, ?, ?)', args: [roomId, memberId, userId] }))
    ], 'write');
    const systemMessage = await createSystemMessage(roomId, userId, `${name} ถูกสร้างขึ้นแล้ว`);
    response.status(201).json({ group: { id: roomId, name, isGroup: true, memberCount: memberIds.length + 1, lastText: '', lastCreatedAt: null, unreadCount: 0 } });
  } catch (_error) {
    response.status(500).json({ error: 'Could not create group' });
  }
});

app.post('/api/conversations/:friendId/read', async (request, response) => {
  const userId = authenticatedUserId(request);
  const friendId = request.params.friendId;
  if (!userId || !db) return response.status(401).json({ error: 'Authentication required' });
  const roomId = directRoomId(userId, friendId);
  const readAt = new Date().toISOString();
  try {
    const result = await db.execute({ sql: "UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE room_id = ? AND user_id <> ? AND read_at IS NULL", args: [readAt, roomId, userId] });
    if (result.rowsAffected) {
      io.to(roomId).emit('messages-read', { roomId, readerId: userId, readAt });
    }
    response.json({ read: true, readAt });
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
    const isGroup = friendId.startsWith('group:');
    const membership = await db.execute(isGroup
      ? { sql: 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', args: [friendId, userId] }
      : { sql: `SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`, args: [userId, friendId] });
    if (!membership.rows.length) return response.status(403).json({ error: 'Conversation access denied' });
    const roomId = isGroup ? friendId : directRoomId(userId, friendId);
    const result = await db.execute({
      sql: `SELECT m.id, m.user_id AS senderId, u.username AS senderName, m.text, m.is_system AS isSystem,
        (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS readCount,
        m.attachment_json AS attachmentJson, m.reply_to AS replyTo, m.reaction_json AS reactionJson,
        m.delivered_at AS deliveredAt, m.read_at AS readAt, m.edited_at AS editedAt,
        m.deleted_at AS deletedAt, m.created_at AS timestamp
        FROM messages m INNER JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ? AND m.deleted_at IS NULL ${before ? 'AND m.created_at < ?' : ''}
        ORDER BY m.created_at DESC LIMIT ?`,
      args: before ? [roomId, before, limit] : [roomId, limit]
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
  try {
    const result = await db.execute({
      sql: `SELECT 1 FROM uploads u
        WHERE u.filename = ? AND (u.user_id = ? OR EXISTS (
          SELECT 1 FROM messages m INNER JOIN room_members rm ON rm.room_id = m.room_id
          WHERE rm.user_id = ? AND json_extract(m.attachment_json, '$.url') = '/uploads/' || ?
        ))`,
      args: [filename, userId, userId, filename]
    });
    if (!result.rows.length) return response.status(404).end();
    response.sendFile(path.join(uploadDirectory, filename));
  } catch (_error) {
    response.status(500).end();
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
    const pending = await db.execute({ sql: "SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'pending'", args: [friendId, userId] });
    if (!pending.rows.length) return response.status(404).json({ error: 'Friend request not found' });
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
  await revokeConversation(userId, request.params.friendId);
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
  await revokeConversation(userId, friendId);
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
app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'Not found' });
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
  broadcastPresence(socket.data.userId, true);

  socket.on('disconnect', () => {
    broadcastPresence(socket.data.userId, false);
  });

  async function socketCanUseRoom() {
    const roomId = roomForSocket();
    if (!db || !roomId || !socket.rooms.has(roomId)) return false;
    if (roomId.startsWith('group:')) {
      const membership = await db.execute({ sql: 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', args: [roomId, socket.data.userId] });
      return membership.rows.length > 0;
    }
    const [, firstId, secondId] = roomId.split(':');
    const peerId = firstId === socket.data.userId ? secondId : firstId;
    if (!peerId || peerId === socket.data.userId) return false;
    const result = await db.execute({
      sql: `SELECT 1 FROM friendships f WHERE f.user_id = ? AND f.friend_id = ? AND f.status = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_id = ? AND b.blocked_user_id = ?) OR (b.user_id = ? AND b.blocked_user_id = ?))`,
      args: [socket.data.userId, peerId, socket.data.userId, peerId, peerId, socket.data.userId]
    });
    return result.rows.length > 0;
  }
  socket.data.messageWindow = [];

  socket.on('join-room', async ({ peerId, roomId, selectionToken }) => {
    if ((!peerId && !roomId) || !db) {
      return socket.emit('chat-error', { message: 'Conversation service is unavailable' });
    }
    try {
      let safeRoomId = null;
      let roomName = 'Direct conversation';
      if (typeof roomId === 'string' && roomId.startsWith('group:')) {
        const membership = await db.execute({
          sql: 'SELECT r.name FROM rooms r INNER JOIN room_members rm ON rm.room_id = r.id WHERE r.id = ? AND rm.user_id = ?',
          args: [roomId, socket.data.userId]
        });
        if (!membership.rows.length) return socket.emit('chat-error', { message: 'You are not a member of this group' });
        safeRoomId = roomId;
        roomName = membership.rows[0].name;
      } else {
        if (typeof peerId !== 'string' || peerId === socket.data.userId) return socket.emit('chat-error', { message: 'Conversation service is unavailable' });
        const membership = await db.execute({
          sql: `SELECT 1 FROM friendships f WHERE f.user_id = ? AND f.friend_id = ? AND f.status = 'accepted'
            AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.user_id = ? AND b.blocked_user_id = ?) OR (b.user_id = ? AND b.blocked_user_id = ?))`,
          args: [socket.data.userId, peerId, socket.data.userId, peerId, peerId, socket.data.userId]
        });
        if (!membership.rows.length) return socket.emit('chat-error', { message: 'You can only message accepted friends' });
        safeRoomId = directRoomId(socket.data.userId, peerId);
      }
      let safeUsername = 'User';
      if (db) {
        const result = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [socket.data.userId] });
        safeUsername = result.rows[0]?.username || safeUsername;
        if (!safeRoomId.startsWith('group:')) {
          await db.execute({ sql: 'INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)', args: [safeRoomId, roomName] });
          await db.batch([
            { sql: 'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', args: [safeRoomId, socket.data.userId] },
            { sql: 'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)', args: [safeRoomId, peerId] }
          ], 'write');
        }
      }

      if (socket.data.roomId) socket.leave(socket.data.roomId);
      socket.join(safeRoomId);
      socket.data.roomId = safeRoomId;
      socket.data.username = safeUsername;

      const members = io.sockets.adapter.rooms.get(safeRoomId);
      socket.emit('room-joined', {
        roomId: safeRoomId,
        isGroup: safeRoomId.startsWith('group:'),
        participantCount: members ? members.size : 1,
        selectionToken
      });
      if (db) {
        const history = await db.execute({
          sql: `SELECT m.id, m.user_id AS senderId, u.username AS senderName, m.text, m.is_system AS isSystem,
            (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS readCount, m.attachment_json AS attachmentJson,
            m.reply_to AS replyTo, m.reaction_json AS reactionJson, m.delivered_at AS deliveredAt, m.read_at AS readAt,
            m.edited_at AS editedAt, m.deleted_at AS deletedAt, m.created_at AS timestamp
            FROM messages m INNER JOIN users u ON u.id = m.user_id WHERE m.room_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 200`,
          args: [safeRoomId]
        });
        await db.execute({ sql: "UPDATE messages SET delivered_at = COALESCE(delivered_at, datetime('now')) WHERE room_id = ? AND user_id <> ?", args: [safeRoomId, socket.data.userId] });
        socket.emit('chat-history', { messages: history.rows, selectionToken });
      }
      socket.to(safeRoomId).emit('peer-joined', { username: safeUsername });
    } catch (_error) {
      socket.emit('chat-error', { message: 'Could not join conversation' });
    }
  });

  socket.on('chat-message', async ({ text, attachment, replyTo }) => {
    const now = Date.now();
    socket.data.messageWindow = socket.data.messageWindow.filter((sentAt) => now - sentAt < 60_000);
    if (socket.data.messageWindow.length >= 60) return socket.emit('chat-error', { message: 'ส่งข้อความเร็วเกินไป กรุณารอสักครู่' });
    socket.data.messageWindow.push(now);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return;

    const message = {
      id: crypto.randomUUID(),
      roomId: roomForSocket(),
      senderId: socket.data.userId,
      senderName: socket.data.username || 'Guest',
      text: text.trim(),
      timestamp: new Date().toISOString()
    };
    if (!await socketCanUseRoom()) return socket.emit('chat-error', { message: 'Conversation access has been revoked' });
    try {
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
      await db.execute({ sql: 'INSERT INTO messages (id, room_id, user_id, text, attachment_json, reply_to, delivered_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))', args: [message.id, roomForSocket(), socket.data.userId, message.text, message.attachment ? JSON.stringify(message.attachment) : null, safeReplyTo] });
    } catch (_error) {
      return socket.emit('chat-error', { message: 'Could not send message' });
    }
    io.to(roomForSocket()).emit('chat-message', message);
  });

  socket.on('react-message', async ({ messageId, emoji }) => {
    const allowedEmojis = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
    if (!db || typeof messageId !== 'string' || !allowedEmojis.includes(emoji) || !await socketCanUseRoom()) return;
    try {
      const messageResult = await db.execute({ sql: 'SELECT reaction_json AS reactions FROM messages WHERE id = ? AND room_id = ?', args: [messageId, roomForSocket()] });
      if (!messageResult.rows.length) return;
      let reactions = {};
      try { reactions = JSON.parse(messageResult.rows[0].reactions || '{}'); } catch (_error) {}
      if (reactions[socket.data.userId] === emoji) delete reactions[socket.data.userId];
      else reactions[socket.data.userId] = emoji;
      await db.execute({ sql: 'UPDATE messages SET reaction_json = ? WHERE id = ? AND room_id = ?', args: [JSON.stringify(reactions), messageId, roomForSocket()] });
      io.to(roomForSocket()).emit('message-reaction', { messageId, reactions });
    } catch (_error) {}
  });

  socket.on('typing', ({ active }) => {
    if (!socket.data.roomId) return;
    socketCanUseRoom().then((allowed) => {
      if (allowed) socket.to(roomForSocket()).emit('typing', { active: Boolean(active), username: socket.data.username || 'เพื่อน' });
    }).catch(() => {});
  });

  socket.on('read-conversation', async ({ peerId, roomId } = {}) => {
    if (!socket.data.roomId || !await socketCanUseRoom()) return;
    try {
      const readAt = new Date().toISOString();
      const activeRoomId = roomId?.startsWith('group:') ? roomId : (peerId ? directRoomId(socket.data.userId, peerId) : null);
      if (!activeRoomId || activeRoomId !== socket.data.roomId) return;
      if (activeRoomId.startsWith('group:')) {
        const unread = await db.execute({
          sql: `SELECT m.id FROM messages m
            WHERE m.room_id = ? AND m.user_id <> ? AND m.is_system = 0
              AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?)`,
          args: [activeRoomId, socket.data.userId, socket.data.userId]
        });
        if (!unread.rows.length) return;
        await db.batch(unread.rows.map((row) => ({
          sql: 'INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)',
          args: [row.id, socket.data.userId, readAt]
        })), 'write');
        io.to(activeRoomId).emit('messages-read', { roomId: activeRoomId, readerId: socket.data.userId, messageIds: unread.rows.map((row) => row.id), readAt });
        return;
      }
      const result = await db.execute({
        sql: "UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE room_id = ? AND user_id <> ? AND read_at IS NULL",
        args: [readAt, activeRoomId, socket.data.userId]
      });
      if (result.rowsAffected) {
        io.to(activeRoomId).emit('messages-read', { roomId: activeRoomId, readerId: socket.data.userId, readAt });
      }
    } catch (_error) {}
  });

  socket.on('edit-message', async ({ messageId, text }) => {
    if (typeof messageId !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 2000 || !db || !await socketCanUseRoom()) return;
    try {
      const updatedAt = new Date().toISOString();
      const result = await db.execute({ sql: 'UPDATE messages SET text = ?, edited_at = ? WHERE id = ? AND user_id = ? AND room_id = ?', args: [text.trim(), updatedAt, messageId, socket.data.userId, roomForSocket()] });
      if (result.rowsAffected) io.to(roomForSocket()).emit('message-edited', { messageId, text: text.trim(), editedAt: updatedAt });
    } catch (_error) {}
  });

  socket.on('delete-message', async ({ messageId }) => {
    if (typeof messageId !== 'string' || !db || !await socketCanUseRoom()) return;
    try {
      const deletedAt = new Date().toISOString();
      const result = await db.execute({ sql: 'UPDATE messages SET text = ?, attachment_json = NULL, deleted_at = ? WHERE id = ? AND user_id = ? AND room_id = ?', args: ['ข้อความถูกลบแล้ว', deletedAt, messageId, socket.data.userId, roomForSocket()] });
      if (result.rowsAffected) io.to(roomForSocket()).emit('message-deleted', { messageId, deletedAt });
    } catch (_error) {}
  });

  socket.on('call-user', async ({ mode } = {}) => {
    socket.data.endCallRequested = false;
    if (!await socketCanUseRoom()) return socket.emit('call-busy');
    try {
      const roomSockets = await io.in(roomForSocket()).fetchSockets();
      const targetSocket = roomSockets.find((candidate) => candidate.data.userId !== socket.data.userId);
      if (!targetSocket) return socket.emit('call-busy');
      const active = await db.execute({
        sql: "SELECT 1 FROM calls WHERE status IN ('ringing', 'answered') AND (caller_id = ? OR callee_id = ? OR caller_id = ? OR callee_id = ?) LIMIT 1",
        args: [targetSocket.data.userId, targetSocket.data.userId, socket.data.userId, socket.data.userId]
      });
      if (active.rows.length) return socket.emit('call-busy');
      const callId = crypto.randomUUID();
      await db.execute({
        sql: 'INSERT INTO calls (id, room_id, caller_id, callee_id, mode, status) VALUES (?, ?, ?, ?, ?, ?)',
        args: [callId, roomForSocket(), socket.data.userId, targetSocket.data.userId, mode === 'audio' ? 'audio' : 'video', 'ringing']
      });
      socket.data.callId = callId;
      if (!socket.connected || socket.data.endCallRequested) {
        await db.execute({ sql: "UPDATE calls SET status = 'missed', ended_at = datetime('now') WHERE id = ? AND status = 'ringing'", args: [callId] });
        socket.data.callId = null;
        return;
      }
      socket.emit('call-started', { callId });
      targetSocket.emit('incoming-call', {
        callerId: socket.id,
        callId,
        callerName: socket.data.username || 'Guest',
        mode: mode === 'audio' ? 'audio' : 'video'
      });
    } catch (_error) {
      socket.emit('call-busy');
    }
  });

  for (const [eventName, status] of [['call-accepted', 'answered'], ['call-rejected', 'rejected']]) {
    socket.on(eventName, async ({ targetId, callId } = {}) => {
      if (typeof targetId !== 'string' || typeof callId !== 'string' || !await socketCanUseRoom()) return;
      try {
        const [targetSocket] = await io.in(targetId).fetchSockets();
        if (!targetSocket || targetSocket.data.roomId !== roomForSocket()) return;
        const result = await db.execute({
          sql: "UPDATE calls SET status = ?, ended_at = CASE WHEN ? = 'answered' THEN ended_at ELSE datetime('now') END WHERE id = ? AND caller_id = ? AND callee_id = ? AND status = 'ringing'",
          args: [status, status, callId, targetSocket.data.userId, socket.data.userId]
        });
        if (!result.rowsAffected) return;
        if (status === 'answered') socket.data.callId = callId;
        targetSocket.emit(eventName, { senderId: socket.id, callId });
      } catch (_error) {}
    });
  }

  // Validate every signaling packet against the persisted call participants.
  // Adapter room/socket targeting works across instances when Redis is enabled.
  for (const eventName of ['webrtc-offer', 'webrtc-answer', 'ice-candidate']) {
    socket.on(eventName, async ({ targetId, callId, ...payload } = {}) => {
      if (typeof targetId !== 'string' || typeof callId !== 'string' || !await socketCanUseRoom()) return;
      try {
        const [targetSocket] = await io.in(targetId).fetchSockets();
        if (!targetSocket || targetSocket.data.roomId !== roomForSocket()) return;
        const call = await db.execute({
          sql: "SELECT 1 FROM calls WHERE id = ? AND status = 'answered' AND ((caller_id = ? AND callee_id = ?) OR (caller_id = ? AND callee_id = ?))",
          args: [callId, socket.data.userId, targetSocket.data.userId, targetSocket.data.userId, socket.data.userId]
        });
        if (!call.rows.length) return;
        targetSocket.emit(eventName, { senderId: socket.id, callId, ...payload });
      } catch (_error) {}
    });
  }

  socket.on('end-call', async ({ callId } = {}) => {
    const activeCallId = typeof callId === 'string' ? callId : socket.data.callId;
    if (!activeCallId) {
      socket.data.endCallRequested = true;
      return;
    }
    if (!db) return;
    try {
      const result = await db.execute({
        sql: "UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END, ended_at = datetime('now') WHERE id = ? AND (caller_id = ? OR callee_id = ?) AND status IN ('ringing', 'answered')",
        args: [activeCallId, socket.data.userId, socket.data.userId]
      });
      if (result.rowsAffected) io.to(roomForSocket()).emit('call-ended', { callId: activeCallId });
    } catch (_error) {}
    socket.data.callId = null;
  });

  socket.on('disconnecting', async () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      socket.to(roomId).emit('peer-left');
      if (db && socket.data.callId) {
        await db.execute({
          sql: "UPDATE calls SET status = CASE WHEN status = 'ringing' THEN 'missed' ELSE 'ended' END, ended_at = datetime('now') WHERE id = ? AND status IN ('ringing', 'answered')",
          args: [socket.data.callId]
        }).catch(() => {});
        socket.to(roomId).emit('call-ended', { callId: socket.data.callId });
      }
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
