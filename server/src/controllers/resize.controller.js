import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import db from '../config/database.js';
import config from '../config/index.js';
import { resizeQueue } from '../services/resize-queue.service.js';
import { probeVideo } from '../services/resize.service.js';
import archiver from 'archiver';

const VALID_RATIOS = ['1:1', '16:9', '9:16'];

/**
 * 创建视频 Resize 任务
 * POST /api/resize
 * Body: { targetRatio, mode } + files
 */
export function createResizeTask(req, res) {
    const { targetRatio, mode = 'center' } = req.body;
    const files = req.files;

    if (!targetRatio || !VALID_RATIOS.includes(targetRatio)) {
        return res.status(400).json({ error: `目标比例无效，支持: ${VALID_RATIOS.join(', ')}` });
    }

    if (!['center', 'smart'].includes(mode)) {
        return res.status(400).json({ error: '模式无效，支持: center, smart' });
    }

    if (!files || files.length === 0) {
        return res.status(400).json({ error: '请上传至少一个视频文件' });
    }

    if (files.length > 20) {
        return res.status(400).json({ error: '单次最多上传20个视频' });
    }

    const taskId = uuidv4();

    // 探测所有视频并确定源比例
    const videoEntries = [];
    for (const file of files) {
        const info = probeVideo(file.path);
        const srcRatio = info
            ? (info.width === info.height ? '1:1'
                : info.width > info.height ? '16:9'
                : '9:16')
            : 'unknown';

        videoEntries.push({
            file,
            videoId: uuidv4(),
            info,
            srcRatio,
        });
    }

    // 使用第一个视频的比例作为任务的源比例
    const sourceRatio = videoEntries[0].srcRatio;

    // 检查源和目标比例是否相同
    if (sourceRatio === targetRatio) {
        files.forEach((f) => fs.existsSync(f.path) && fs.unlinkSync(f.path));
        return res.status(400).json({ error: '源视频比例与目标比例相同，无需转换' });
    }

    // 创建任务记录
    db.prepare(
        'INSERT INTO resize_tasks (task_id, user_id, source_ratio, target_ratio, mode, status, total_videos) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(taskId, req.user.id, sourceRatio, targetRatio, mode, 'queued', files.length);

    // 创建视频记录并入队
    const insertVideo = db.prepare(
        'INSERT INTO resize_videos (task_id, video_id, original_filename, input_path, source_width, source_height, target_width, target_height, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const TARGET_DIMS = { '1:1': [1080, 1080], '16:9': [1920, 1080], '9:16': [1080, 1920] };
    const [tgtW, tgtH] = TARGET_DIMS[targetRatio];

    for (const entry of videoEntries) {
        const relativePath = path.relative(config.upload.dir, entry.file.path);
        insertVideo.run(
            taskId,
            entry.videoId,
            entry.file.originalname,
            relativePath,
            entry.info?.width || 0,
            entry.info?.height || 0,
            tgtW,
            tgtH,
            'queued'
        );

        const ext = path.extname(entry.file.originalname) || '.mp4';
        const outputFilename = `${path.basename(entry.file.originalname, ext)}_${targetRatio.replace(':', 'x')}${ext}`;
        const outputPath = path.join(config.upload.outputsDir, `resize_${taskId}`, outputFilename);

        resizeQueue.add(
            'resize-video',
            {
                videoId: entry.videoId,
                taskId,
                userId: req.user.id,
                inputPath: entry.file.path,
                outputPath,
                targetRatio,
                mode,
            },
            { jobId: entry.videoId }
        );
    }

    const task = db.prepare('SELECT * FROM resize_tasks WHERE task_id = ?').get(taskId);
    const videos = db.prepare('SELECT * FROM resize_videos WHERE task_id = ?').all(taskId);

    res.status(201).json({ task, videos });
}

/**
 * 列出当前用户的 Resize 任务
 * GET /api/resize
 */
export function listResizeTasks(req, res) {
    const tasks = db.prepare(
        'SELECT * FROM resize_tasks WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.user.id);

    res.json({ tasks });
}

/**
 * 获取单个 Resize 任务详情
 * GET /api/resize/:id
 */
export function getResizeTask(req, res) {
    const task = db.prepare(
        'SELECT * FROM resize_tasks WHERE task_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);

    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const videos = db.prepare(
        'SELECT * FROM resize_videos WHERE task_id = ? ORDER BY id ASC'
    ).all(task.task_id);

    res.json({ task, videos });
}

/**
 * 更新视频的裁切路径（用户标注关键帧）
 * PUT /api/resize/:id/videos/:videoId/crop-path
 * Body: { keyframes: [...] }
 */
export function updateCropPath(req, res) {
    const { id, videoId } = req.params;
    const { keyframes } = req.body;

    const task = db.prepare(
        'SELECT * FROM resize_tasks WHERE task_id = ? AND user_id = ?'
    ).get(id, req.user.id);

    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    if (!keyframes || !Array.isArray(keyframes)) {
        return res.status(400).json({ error: 'keyframes 必须是数组' });
    }

    db.prepare(
        'UPDATE resize_videos SET crop_path = ? WHERE task_id = ? AND video_id = ?'
    ).run(JSON.stringify(keyframes), id, videoId);

    res.json({ message: '裁切路径已更新' });
}

/**
 * 重试失败的 Resize 视频
 * POST /api/resize/:id/retry
 */
export function retryResizeTask(req, res) {
    const task = db.prepare(
        'SELECT * FROM resize_tasks WHERE task_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);

    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const failedVideos = db.prepare(
        "SELECT * FROM resize_videos WHERE task_id = ? AND status = 'failed'"
    ).all(task.task_id);

    if (failedVideos.length === 0) {
        return res.status(400).json({ error: '没有失败的视频需要重试' });
    }

    db.prepare(
        "UPDATE resize_videos SET status = 'queued', error_message = NULL, progress_percent = 0 WHERE task_id = ? AND status = 'failed'"
    ).run(task.task_id);
    db.prepare(
        "UPDATE resize_tasks SET status = 'processing', failed_videos = 0 WHERE task_id = ?"
    ).run(task.task_id);

    for (const video of failedVideos) {
        const inputPath = path.join(config.upload.dir, video.input_path);
        const ext = path.extname(video.original_filename) || '.mp4';
        const outputFilename = `${path.basename(video.original_filename, ext)}_${task.target_ratio.replace(':', 'x')}${ext}`;
        const outputPath = path.join(config.upload.outputsDir, `resize_${task.task_id}`, outputFilename);

        resizeQueue.add(
            'resize-video',
            {
                videoId: video.video_id,
                taskId: task.task_id,
                userId: req.user.id,
                inputPath,
                outputPath,
                targetRatio: task.target_ratio,
                mode: task.mode,
                keyframes: video.crop_path ? JSON.parse(video.crop_path) : undefined,
            },
            { jobId: `retry-${video.video_id}-${Date.now()}` }
        );
    }

    res.json({ message: `已重新提交 ${failedVideos.length} 个视频` });
}

/**
 * 删除 Resize 任务
 * DELETE /api/resize/:id
 */
export function deleteResizeTask(req, res) {
    const task = db.prepare(
        'SELECT * FROM resize_tasks WHERE task_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);

    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const outputDir = path.join(config.upload.outputsDir, `resize_${task.task_id}`);
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }

    const videos = db.prepare('SELECT * FROM resize_videos WHERE task_id = ?').all(task.task_id);
    for (const v of videos) {
        const inputPath = path.join(config.upload.dir, v.input_path);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    }

    db.prepare('DELETE FROM resize_videos WHERE task_id = ?').run(task.task_id);
    db.prepare('DELETE FROM resize_tasks WHERE task_id = ?').run(task.task_id);

    res.json({ message: '任务已删除' });
}

/**
 * 下载单个 Resize 视频
 * GET /api/resize/:id/download/:videoId
 */
export function downloadResizeVideo(req, res) {
    const { id, videoId } = req.params;

    const task = db.prepare(
        'SELECT * FROM resize_tasks WHERE task_id = ? AND user_id = ?'
    ).get(id, req.user.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    const video = db.prepare(
        "SELECT * FROM resize_videos WHERE task_id = ? AND video_id = ? AND status = 'completed'"
    ).get(id, videoId);
    if (!video || !video.output_path) {
        return res.status(404).json({ error: '视频未找到或尚未处理完成' });
    }

    const filePath = path.join(config.upload.dir, video.output_path);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    const ext = path.extname(video.original_filename) || '.mp4';
    const downloadName = `${path.basename(video.original_filename, ext)}_${task.target_ratio.replace(':', 'x')}${ext}`;
    res.download(filePath, downloadName);
}

/**
 * 批量下载 Resize 任务所有视频
 * GET /api/resize/:id/download-all
 */
export function downloadAllResizeVideos(req, res) {
    const task = db.prepare(
        'SELECT * FROM resize_tasks WHERE task_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    const videos = db.prepare(
        "SELECT * FROM resize_videos WHERE task_id = ? AND status = 'completed'"
    ).all(task.task_id);

    if (videos.length === 0) {
        return res.status(400).json({ error: '没有已完成的视频' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="resize_${task.task_id.slice(0, 8)}_videos.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.pipe(res);

    for (const video of videos) {
        const filePath = path.join(config.upload.dir, video.output_path);
        if (fs.existsSync(filePath)) {
            const ext = path.extname(video.original_filename) || '.mp4';
            const name = `${path.basename(video.original_filename, ext)}_${task.target_ratio.replace(':', 'x')}${ext}`;
            archive.file(filePath, { name });
        }
    }

    archive.finalize();
}

/**
 * 获取视频分析信息（用于前端预览）
 * GET /api/resize/probe?path=xxx
 */
export function probeVideoInfo(req, res) {
    const videoPath = req.query.path;
    if (!videoPath) {
        return res.status(400).json({ error: '请提供视频路径' });
    }

    const fullPath = path.join(config.upload.dir, videoPath);
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: '视频不存在' });
    }

    const info = probeVideo(fullPath);
    if (!info) {
        return res.status(500).json({ error: '视频分析失败' });
    }

    res.json(info);
}
