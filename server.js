// server.js - API Gateway Implementation
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const http = require('http');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const redis = require('./config/redis');
// Load configuration
require('dotenv').config();
const { initializeDatabase } = require('./database-init');


// Import middleware
const { authenticateToken, optionalAuth } = require('./middleware/auth.middleware');
const errorMiddleware = require('./middleware/error.middleware');

// Import routes
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const songRoutes = require('./routes/song.routes');
const matchRoutes = require('./routes/match.routes');
const recommendationRoutes = require('./routes/recommendation.routes');
const chatRoutes = require('./routes/chat.routes');


// Create Express app
const app = express();
const server = http.createServer(app);

// Socket.IO setup
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(helmet()); // Security headers

// Create a write stream for logs
// const logStream = fs.createWriteStream(path.join(__dirname, 'access.log'), { flags: 'a' });

// // Use both file and console logging
// app.use(morgan('combined', { stream: logStream }));
// app.use(morgan('dev')); // Keep console logging for development


app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json()); // Parse JSON request body
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request body

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true, // Return rate limit info in the RateLimit-* headers
  legacyHeaders: false, // Disable the X-RateLimit-* headers
  message: 'Too many requests from this IP, please try again later.'
});

// Apply rate limiting to API endpoints
app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get("/",(req,res)=>{
  res.send("Hello World");
})

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/songs', optionalAuth, songRoutes);
app.use('/api/matches', authenticateToken, matchRoutes);
app.use('/api/recommendations', authenticateToken, recommendationRoutes);
app.use('/api/chats', authenticateToken, chatRoutes);

// Proxy to FastAPI Music Service
app.use('/api/saavn', createProxyMiddleware({
  target: process.env.MUSIC_API_URL || 'http://localhost:8000',
  changeOrigin: true,
  followRedirects: true,
  pathRewrite: {
    '^/api/saavn': '' // Rewrite path
  },
  onProxyReq: (proxyReq, req, res) => {
    // Forward auth header if available
    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }
  }
}));

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Authentication token required'));
    }
    
    // Verify token (uses same JWT verification as HTTP routes)
    const { verifyToken, isTokenBlacklisted } = require('./config/jwt');
    
    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      return next(new Error('Token has been revoked'));
    }
    
    const decoded = await verifyToken(token);
    
    // Attach user to socket
    socket.user = {
      id: decoded.userId,
      username: decoded.username
    };
    
    next();
  } catch (error) {
    return next(new Error('Authentication failed'));
  }
});

// Socket.IO connection handler
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
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${userId}`);
  });
});

// Error handling middleware (must be after all routes)
app.use(errorMiddleware);

// Start server
const PORT = process.env.PORT || 3000;
initializeDatabase()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

// For handling Ctrl+C in terminal
process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

// At the bottom of server.js
if (process.env.RUN_WORKERS === 'true') {
  require('./workers/listen-events.worker');
  require('./workers/song-data.worker');
  require('./workers/match-calculation.worker');
}

