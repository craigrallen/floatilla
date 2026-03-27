require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const { authenticateSocket } = require('./auth');
const { getDb } = require('./db');

const app = express();
const server = http.createServer(app);

// CORS
const corsOrigins = process.env.CORS_ORIGINS || '*';
const corsOptions = corsOrigins === '*'
  ? { origin: true, credentials: true }
  : { origin: corsOrigins.split(',').map(s => s.trim()), credentials: true };

app.use(cors(corsOptions));
app.use(express.json());

// Track connected users: userId -> Set<socketId>
const connectedUsers = new Map();
app.set('connectedUsers', connectedUsers);

// Socket.io
const io = new SocketServer(server, {
  cors: corsOptions,
  pingInterval: 25000,
  pingTimeout: 60000
});
app.set('io', io);

io.use(authenticateSocket);

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`Socket connected: user ${userId}`);

  // Join personal room
  socket.join(`user:${userId}`);

  // Track connection
  if (!connectedUsers.has(userId)) {
    connectedUsers.set(userId, new Set());
  }
  connectedUsers.get(userId).add(socket.id);

  socket.on('disconnect', () => {
    const sockets = connectedUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        connectedUsers.delete(userId);
      }
    }
    console.log(`Socket disconnected: user ${userId}`);
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/friends', require('./routes/friends'));
app.use('/messages', require('./routes/messages'));
app.use('/location', require('./routes/location'));
app.use('/waypoints', require('./routes/waypoints'));

// Initialize database on startup
getDb();

const PORT = parseInt(process.env.PORT, 10) || 3100;
server.listen(PORT, () => {
  console.log(`Fleet Social relay server running on port ${PORT}`);
});
