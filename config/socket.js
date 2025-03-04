// config/socket.js
const socketIo = require('socket.io');
const { verifyToken, isTokenBlacklisted } = require('./jwt');
const { subscribe, CHANNELS } = require('./redis');

/**
 * Configure and initialize Socket.IO
 * 
 * @param {Object} server - HTTP server instance
 * @returns {Object} Configured Socket.IO instance
 */
const setupSocketIO = (server) => {
  const io = socketIo(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true
    }
  });
  
  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication token required'));
      }
      
      // Check if token is blacklisted
      const blacklisted = await isTokenBlacklisted(token);
      if (blacklisted) {
        return next(new Error('Token has been revoked'));
      }
      
      // Verify token
      const decoded = await verifyToken(token);
      
      // Attach user to socket
      socket.user = {
        id: decoded.userId,
        username: decoded.username,
        role: decoded.role || 'user'
      };
      
      next();
    } catch (error) {
      return next(new Error('Authentication failed'));
    }
  });
  
  // Connection handler
  io.on('connection', (socket) => {
    const userId = socket.user.id;
    
    console.log(`User connected: ${userId}`);
    
    // Join user's room for personal notifications
    socket.join(userId);
    
    // Handle joining specific chat rooms
    socket.on('join-conversation', (conversationId) => {
      socket.join(`conversation:${conversationId}`);
    });
    
    // Handle leaving chat rooms
    socket.on('leave-conversation', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });
    
    // Handle user online status
    socket.on('set-status', async (status) => {
      if (status === 'online' || status === 'offline' || status === 'away') {
        // Store user status in Redis
        await redis.hset(`user:${userId}:status`, 'status', status);
        await redis.hset(`user:${userId}:status`, 'last_updated', Date.now());
        
        // Broadcast to user's matches
        socket.broadcast.emit('user-status', {
          userId,
          status
        });
      }
    });
    
    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${userId}`);
      
      // Update user status
      await redis.hset(`user:${userId}:status`, 'status', 'offline');
      await redis.hset(`user:${userId}:status`, 'last_updated', Date.now());
      
      // Broadcast to user's matches
      socket.broadcast.emit('user-status', {
        userId,
        status: 'offline'
      });
    });
  });
  
  // Subscribe to Redis channels and forward to Socket.IO
  setupRedisSubscriptions(io);
  
  return io;
};

/**
 * Set up Redis subscriptions for real-time events
 * 
 * @param {Object} io - Socket.IO instance
 */
function setupRedisSubscriptions(io) {
  // Listen for chat messages
  subscribe(CHANNELS.CHAT_MESSAGE, (message) => {
    // Send to recipient's room
    io.to(message.recipientId).emit('new-message', {
      conversationId: message.conversationId,
      messageId: message.messageId,
      senderId: message.senderId,
      text: message.text,
      sentAt: message.sentAt,
      sharedSongId: message.sharedSongId
    });
    
    // Also send to conversation room if anyone is listening
    io.to(`conversation:${message.conversationId}`).emit('new-message', {
      messageId: message.messageId,
      senderId: message.senderId,
      text: message.text,
      sentAt: message.sentAt,
      sharedSongId: message.sharedSongId
    });
  });
  
  // Listen for match updates
  subscribe(CHANNELS.MATCH_UPDATE, (message) => {
    io.to(message.userId).emit('match-update', {
      matchId: message.matchId,
      status: message.status,
      initiatedBy: message.initiatedBy,
      conversationId: message.conversationId
    });
  });
  
  // Listen for song listens (for activity feed)
  subscribe(CHANNELS.SONG_LISTEN, (message) => {
    // This could be used for an activity feed or "now playing" feature
    io.to(message.userId).emit('song-listen', {
      userId: message.userId,
      songId: message.songId,
      timestamp: message.timestamp
    });
  });
}

module.exports = setupSocketIO;