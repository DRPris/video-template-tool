import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import db from '../config/database.js';
import config from '../config/index.js';
import { videoQueue } from '../services/queue.service.js';
import archiver from 'archiver';

export function createTask(req, res) {
    const { templateId, templateIds } = req.body;
    const files = req.files;

    // Support multiple templates: templateIds (comma-separated) or single templateId
    let tplIds = [];
    if (templateIds) {
        tplIds = String(templateIds).split(',').map(id => id.trim()).filter(Boolean);
    } else if (templateId) {
        tplIds = [String(templateId).trim()];
    }

    if (tplIds.length === 0) {
        return res.status(400).json({ error: '请选择至少一个模板' });
    }

    if (!files || files.length === 0) {
        return res.status(400).json({ error: '请上传至少一个视频文件' });
    }

    if (files.length > 20) {
        return res.status(400).json({ error: '单次最多上传20个视频' });
    }

    // Validate all templates exist
    const templates = [];
    for (const tid of tplIds) {
        const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(tid);
        if (!tpl) {
            files.forEach((f) => fs.existsSync(f.path) && fs.unlinkSync(f.path));
            return res.status(404).json({ error: `模板 ID ${tid} 不存在` });
        }
        templates.push(tpl);
    }

    // Check user's active task queue
    const totalNewVideos = files.length * templates.length;
    const activeCount = db.prepare(
        "SELECT COUNT(*) as count FROM task_videos tv JOIN tasks t ON tv.task_id = t.task_id WHERE t.user_id = ? AND tv.status IN ('queued', 'processing')"
    ).get(req.user.id);

    if (activeCount.count + totalNewVideos > 60) {
        files.forEach((f) => fs.existsSync(f.path) && fs.unlinkSync(f.path));
        return res.status(400).json({
            error: `队列已满，当前 ${activeCount.count} 个视频在处理中`,
        });
    }

    const createdTasks = [];
    const insertTask = db.prepare(
        'INSERT INTO tasks (task_id, user_id, template_id, status, total_videos) VALUES (?, ?, ?, ?, ?)'
    );
    const insertVideo = db.prepare(
        'INSERT INTO task_videos (task_id, video_id, original_filename, input_path, status) VALUES (?, ?, ?, ?, ?)'
    );

    for (let tplIdx = 0; tplIdx < templates.length; tplIdx++) {
        const template = templates[tplIdx];
        const taskId = uuidv4();
        const templateImagePath = path.join(config.upload.dir, template.file_path);

        insertTask.run(taskId, req.user.id, template.id, 'queued', files.length);

        for (const file of files) {
            const videoId = uuidv4();
            let videoPath = file.path;
            let relativePath = path.relative(config.upload.dir, file.path);

            // For 2nd+ templates, copy the video file so each task has its own
            if (tplIdx > 0) {
                const ext = path.extname(file.originalname);
                const copyName = `video_${uuidv4()}${ext}`;
                const copyPath = path.join(config.upload.videosDir, copyName);
                fs.copyFileSync(file.path, copyPath);
                videoPath = copyPath;
                relativePath = path.relative(config.upload.dir, copyPath);
            }

            insertVideo.run(taskId, videoId, file.originalname, relativePath, 'queued');

            const ext = path.extname(file.originalname) || '.mp4';
            const outputFilename = `${path.basename(file.originalname, ext)}_${template.type.replace(':', 'x')}${ext}`;
            const outputPath = path.join(config.upload.outputsDir, taskId, outputFilename);

            videoQueue.add(
                'process-video',
                {
                    videoId,
                    taskId,
                    userId: req.user.id,
                    inputPath: videoPath,
                    templateImagePath,
                    template,
                    outputPath,
                },
                { jobId: videoId }
            );
        }

        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        const videos = db.prepare('SELECT * FROM task_videos WHERE task_id = ?').all(taskId);
        createdTasks.push({ task, videos });
    }

    // Return first task for backwards compatibility, plus all tasks
    res.status(201).json({
        task: createdTasks[0].task,
        videos: createdTasks[0].videos,
        allTasks: createdTasks,
        totalTasks: createdTasks.length,
    });
}

export function listTasks(req, res) {
    const tasks = db.prepare(
        'SELECT t.*, tpl.name as template_name, tpl.type as template_type FROM tasks t LEFT JOIN templates tpl ON t.template_id = tpl.id WHERE t.user_id = ? ORDER BY t.created_at DESC'
    ).all(req.user.id);

    res.json({ tasks });
}

export function getTask(req, res) {
    const task = db.prepare(
        'SELECT t.*, tpl.name as template_name, tpl.type as template_type FROM tasks t LEFT JOIN templates tpl ON t.template_id = tpl.id WHERE t.task_id = ? AND t.user_id = ?'
    ).get(req.params.id, req.user.id);

    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const videos = db.prepare('SELECT * FROM task_videos WHERE task_id = ? ORDER BY id ASC').all(task.task_id);

    res.json({ task, videos });
}

export function retryTask(req, res) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const failedVideos = db.prepare("SELECT * FROM task_videos WHERE task_id = ? AND status = 'failed'").all(task.task_id);

    if (failedVideos.length === 0) {
        return res.status(400).json({ error: '没有失败的视频需要重试' });
    }

    const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(task.template_id);
    if (!template) {
        return res.status(404).json({ error: '模板已被删除' });
    }

    const templateImagePath = path.join(config.upload.dir, template.file_path);

    // Reset failed videos
    db.prepare("UPDATE task_videos SET status = 'queued', error_message = NULL, progress_percent = 0 WHERE task_id = ? AND status = 'failed'").run(task.task_id);
    db.prepare("UPDATE tasks SET status = 'processing', failed_videos = 0 WHERE task_id = ?").run(task.task_id);

    for (const video of failedVideos) {
        const inputPath = path.join(config.upload.dir, video.input_path);
        const ext = path.extname(video.original_filename) || '.mp4';
        const outputFilename = `${path.basename(video.original_filename, ext)}_${template.type.replace(':', 'x')}${ext}`;
        const outputPath = path.join(config.upload.outputsDir, task.task_id, outputFilename);

        videoQueue.add(
            'process-video',
            {
                videoId: video.video_id,
                taskId: task.task_id,
                userId: req.user.id,
                inputPath,
                templateImagePath,
                template,
                outputPath,
            },
            {
                jobId: `retry-${video.video_id}-${Date.now()}`,
            }
        );
    }

    res.json({ message: `已重新提交 ${failedVideos.length} 个视频` });
}

export function deleteTask(req, res) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    // Delete output files
    const outputDir = path.join(config.upload.outputsDir, task.task_id);
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }

    // Delete input videos
    const videos = db.prepare('SELECT * FROM task_videos WHERE task_id = ?').all(task.task_id);
    for (const v of videos) {
        const inputPath = path.join(config.upload.dir, v.input_path);
        if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
        }
    }

    db.prepare('DELETE FROM task_videos WHERE task_id = ?').run(task.task_id);
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(task.task_id);

    res.json({ message: '任务已删除' });
}

export function downloadVideo(req, res) {
    const { id, videoId } = req.params;

    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ? AND user_id = ?').get(id, req.user.id);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const video = db.prepare("SELECT * FROM task_videos WHERE task_id = ? AND video_id = ? AND status = 'completed'").get(id, videoId);
    if (!video || !video.output_path) {
        return res.status(404).json({ error: '视频未找到或尚未处理完成' });
    }

    const filePath = path.join(config.upload.dir, video.output_path);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    const ext = path.extname(video.original_filename) || '.mp4';
    const downloadName = `${path.basename(video.original_filename, ext)}_output${ext}`;
    res.download(filePath, downloadName);
}

export function downloadAll(req, res) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!task) {
        return res.status(404).json({ error: '任务不存在' });
    }

    const videos = db.prepare("SELECT * FROM task_videos WHERE task_id = ? AND status = 'completed'").all(task.task_id);
    if (videos.length === 0) {
        return res.status(400).json({ error: '没有已完成的视频' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="task_${task.task_id.slice(0, 8)}_videos.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } }); // Fast compression for video
    archive.pipe(res);

    for (const video of videos) {
        const filePath = path.join(config.upload.dir, video.output_path);
        if (fs.existsSync(filePath)) {
            const ext = path.extname(video.original_filename) || '.mp4';
            const name = `${path.basename(video.original_filename, ext)}_output${ext}`;
            archive.file(filePath, { name });
        }
    }

    archive.finalize();
}
