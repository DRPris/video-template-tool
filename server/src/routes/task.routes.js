import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';
import { authenticate } from '../middleware/auth.js';
import { createTask, listTasks, getTask, retryTask, deleteTask, downloadVideo, downloadAll } from '../controllers/task.controller.js';

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.upload.videosDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `video_${uuidv4()}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: config.upload.maxFileSize },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'video/mp4',
            'video/quicktime',
            'video/x-msvideo',
            'video/x-matroska',
            'video/webm',
            'video/3gpp',
            'application/octet-stream',
        ];
        const allowedExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的视频格式，支持: mp4, mov, avi, mkv, webm, m4v, 3gp'));
        }
    },
});

const router = Router();

router.use(authenticate);

router.post('/', upload.array('videos', 20), createTask);
router.get('/', listTasks);
router.get('/:id', getTask);
router.post('/:id/retry', retryTask);
router.delete('/:id', deleteTask);
router.get('/:id/download/:videoId', downloadVideo);
router.get('/:id/download-all', downloadAll);

export default router;
