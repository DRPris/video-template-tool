import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import app from './app.js';
import config from './config/index.js';
import { startWorker, setSocketIO } from './services/queue.service.js';

const server = http.createServer(app);

// Setup Socket.IO
const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*',
        methods: ['GET', 'POST'],
    },
});

// Socket.IO authentication
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('认证失败'));
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        socket.userId = decoded.userId;
        next();
    } catch (err) {
        next(new Error('Token 无效'));
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 User ${socket.userId} connected via WebSocket`);

    // Join user-specific room for targeted progress updates
    socket.join(`user:${socket.userId}`);

    socket.on('disconnect', () => {
        console.log(`🔌 User ${socket.userId} disconnected`);
    });
});

// Share Socket.IO instance with queue service
setSocketIO(io);

// Start the video processing worker
startWorker();

// Start server
server.listen(config.port, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   🎬 视频套模板工具 API 服务器           ║
║   端口: ${config.port}                            ║
║   环境: ${config.env}                   ║
║   FFmpeg 并发数: ${config.ffmpeg.concurrency}                      ║
╚══════════════════════════════════════════╝
  `);
});

export default server;
