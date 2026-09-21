const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { initializeDatabase } = require('./db');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ['GET', 'POST'] }
});

const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');

app.use(express.static(publicDirectory));
app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'instant-messaging-networking-demo', timestamp: new Date().toISOString() });
});
app.get('*', (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'index.html'));
});

// Socket.io uses a persistent TCP connection (normally upgraded to WebSocket)
// to transport chat messages and signaling packets with low latency.
io.on('connection', (socket) => {
  const roomForSocket = (requestedRoom) => requestedRoom === socket.data.roomId ? requestedRoom : socket.data.roomId;

  socket.on('join-room', ({ roomId, username }) => {
    const safeRoomId = typeof roomId === 'string' && roomId.length <= 80 ? roomId : 'networking-demo';
    const safeUsername = typeof username === 'string' && username.trim() ? username.trim().slice(0, 40) : 'Guest';

    socket.join(safeRoomId);
    socket.data.roomId = safeRoomId;
    socket.data.username = safeUsername;

    const members = io.sockets.adapter.rooms.get(safeRoomId);
    socket.emit('room-joined', {
      roomId: safeRoomId,
      participantCount: members ? members.size : 1
    });
    socket.to(safeRoomId).emit('peer-joined', { username: safeUsername });
  });

  socket.on('chat-message', ({ roomId, text }) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return;

    // The server forwards the message over TCP; it does not store message content.
    io.to(roomForSocket(roomId)).emit('chat-message', {
      id: `${socket.id}-${Date.now()}`,
      senderId: socket.id,
      senderName: socket.data.username || 'Guest',
      text: text.trim(),
      timestamp: new Date().toISOString()
    });
  });

  socket.on('call-user', ({ roomId, mode }) => {
    socket.to(roomForSocket(roomId)).emit('incoming-call', {
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

  socket.on('end-call', ({ roomId } = {}) => {
    socket.to(roomForSocket(roomId)).emit('call-ended');
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
