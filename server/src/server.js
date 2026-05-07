import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import app from './app.js';
import config from './config/index.js';
import { startWorker, setSocketIO } from './services/queue.service.js';
import { startResizeWorker, setResizeSocketIO } from './services/resize-queue.service.js';

const server = http.createServer(app);

// Setup Socket.IO
const io = new Server(server, {
    cors: {
        // 生产环境建议显式设置 FRONTEND_URL（例如 http://localhost 或你的域名）。
        // 但为了避免未配置时直接导致 WS 握手被 CORS 拒绝，这里做一个安全兜底：
        // - 配了 FRONTEND_URL：严格按它来
        // - 没配：允许所有来源（等你部署到公网后再收紧）
        origin:
            process.env.NODE_ENV === 'production'
                ? (process.env.FRONTEND_URL || '*')
                : '*',
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
setResizeSocketIO(io);

// Start the video processing workers
startWorker();
startResizeWorker();

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
