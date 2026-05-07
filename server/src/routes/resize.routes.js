import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';
import { authenticate } from '../middleware/auth.js';
import {
    createResizeTask,
    listResizeTasks,
    getResizeTask,
    updateCropPath,
    retryResizeTask,
    deleteResizeTask,
    downloadResizeVideo,
    downloadAllResizeVideos,
    probeVideoInfo,
} from '../controllers/resize.controller.js';

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.upload.videosDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `resize_${uuidv4()}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: config.upload.maxFileSize },
    fileFilter: (req, file, cb) => {
        const allowedExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的视频格式，支持: mp4, mov, avi, mkv, webm, m4v, 3gp'));
        }
    },
});

const router = Router();

router.use(authenticate);

// 创建 Resize 任务（上传视频 + 选择目标比例）
router.post('/', upload.array('videos', 20), createResizeTask);

// 列出 Resize 任务
router.get('/', listResizeTasks);

// 获取视频探测信息
router.get('/probe', probeVideoInfo);

// 获取单个 Resize 任务详情
router.get('/:id', getResizeTask);

// 更新视频裁切路径（关键帧标注）
router.put('/:id/videos/:videoId/crop-path', updateCropPath);

// 重试失败视频
router.post('/:id/retry', retryResizeTask);

// 删除任务
router.delete('/:id', deleteResizeTask);

// 下载单个视频
router.get('/:id/download/:videoId', downloadResizeVideo);

// 批量下载
router.get('/:id/download-all', downloadAllResizeVideos);

export default router;
