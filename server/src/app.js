import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import path from 'path';
import config from './config/index.js';
import authRoutes from './routes/auth.routes.js';
import templateRoutes from './routes/template.routes.js';
import taskRoutes from './routes/task.routes.js';

const app = express();

// Security
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*',
    credentials: true,
}));

// Logging
app.use(morgan('short'));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files - serve uploaded files
app.use('/uploads', express.static(config.upload.dir));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/tasks', taskRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Error:', err);

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: '文件过大，请上传小于500MB的文件' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: '单次最多上传20个视频' });
        }
        return res.status(400).json({ error: `上传错误: ${err.message}` });
    }

    if (err.message && (err.message.includes('仅支持') || err.message.includes('不支持的视频格式'))) {
        return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: '服务器内部错误' });
});

export default app;
