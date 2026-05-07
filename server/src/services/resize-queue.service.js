import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import config from '../config/index.js';
import db from '../config/database.js';
import path from 'path';
import { processResize } from './resize.service.js';

const connection = {
    host: config.redis.host,
    port: config.redis.port,
};

// 独立 Redis 客户端（用于与 CV 服务通信）
const redisClient = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
});

// Resize 任务队列
export const resizeQueue = new Queue('video-resize', {
    connection,
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
    },
});

// Socket.IO instance（从 server.js 注入）
let io = null;
export function setResizeSocketIO(socketIO) {
    io = socketIO;
}

function emitProgress(userId, data) {
    if (io) {
        io.to(`user:${userId}`).emit('resize:progress', data);
    }
}

/**
 * 向 Python CV 服务发送分析请求，并轮询等待结果
 * @returns {object|null} 分析结果（含 crop_path）或 null
 */
async function requestCVAnalysis(videoId, taskId, videoPath, targetRatio, keyframes) {
    const request = JSON.stringify({
        videoId,
        taskId,
        videoPath,
        targetRatio,
        keyframes: keyframes || null,
    });

    // 推入 CV 分析队列
    await redisClient.rpush('cv:analyze:queue', request);
    console.log(`📤 Sent CV analysis request for video ${videoId}`);

    // 轮询等待结果 (最多等 120 秒)
    const statusKey = `cv:status:${videoId}`;
    const resultKey = `cv:analyze:result:${videoId}`;
    const maxWait = 120;
    const pollInterval = 1000;
    let waited = 0;

    while (waited < maxWait * 1000) {
        const status = await redisClient.hget(statusKey, 'status');

        if (status === 'completed') {
            const raw = await redisClient.get(resultKey);
            if (raw) {
                return JSON.parse(raw);
            }
            return null;
        }

        if (status === 'failed') {
            const error = await redisClient.hget(statusKey, 'error');
            throw new Error(`CV 分析失败: ${error || '未知错误'}`);
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waited += pollInterval;
    }

    throw new Error('CV 分析超时 (120s)');
}

// 启动 Resize Worker
export function startResizeWorker() {
    const worker = new Worker(
        'video-resize',
        async (job) => {
            const { videoId, taskId, userId, inputPath, outputPath, targetRatio, mode, keyframes } = job.data;

            console.log(`🔄 Resize video ${videoId} for task ${taskId} → ${targetRatio} (mode: ${mode})`);

            // 更新状态
            db.prepare("UPDATE resize_videos SET status = 'processing', started_at = CURRENT_TIMESTAMP WHERE video_id = ?").run(videoId);

            const task = db.prepare('SELECT * FROM resize_tasks WHERE task_id = ?').get(taskId);
            if (task && task.status === 'queued') {
                db.prepare("UPDATE resize_tasks SET status = 'processing' WHERE task_id = ?").run(taskId);
            }

            emitProgress(userId, { taskId, videoId, status: 'processing', progress: 0 });

            try {
                let cropKeyframes = keyframes;

                // 智能模式：先请求 CV 服务分析
                if (mode === 'smart' && !keyframes) {
                    emitProgress(userId, { taskId, videoId, status: 'analyzing', progress: 5 });

                    console.log(`🧠 Smart mode: requesting CV analysis for video ${videoId}`);
                    const cvResult = await requestCVAnalysis(videoId, taskId, inputPath, targetRatio);

                    if (cvResult && cvResult.crop_path && cvResult.crop_path.length > 0) {
                        cropKeyframes = cvResult.crop_path;
                        // 存储分析结果到数据库
                        db.prepare('UPDATE resize_videos SET crop_path = ? WHERE video_id = ?')
                            .run(JSON.stringify({
                                auto_keyframes: cvResult.keyframes,
                                scene_summary: cvResult.scene_summary,
                                crop_path: cvResult.crop_path,
                            }), videoId);

                        console.log(`🧠 CV analysis done: scene=${cvResult.scene_summary.dominant_scene}, keyframes=${cvResult.keyframes.length}`);
                    } else {
                        console.log(`⚠️ CV analysis returned no crop path, falling back to center crop`);
                    }
                }

                const { videoInfo } = await processResize(
                    { inputVideo: inputPath, outputPath, targetRatio, mode, keyframes: cropKeyframes },
                    (percent) => {
                        // 智能模式下，分析阶段占前 30%，FFmpeg 占 30%-100%
                        const adjustedPercent = mode === 'smart' && !keyframes
                            ? 30 + Math.round(percent * 0.7)
                            : percent;
                        db.prepare('UPDATE resize_videos SET progress_percent = ? WHERE video_id = ?').run(adjustedPercent, videoId);
                        emitProgress(userId, { taskId, videoId, status: 'processing', progress: adjustedPercent });
                    }
                );

                // 更新视频尺寸信息
                db.prepare(
                    "UPDATE resize_videos SET status = 'completed', output_path = ?, source_width = ?, source_height = ?, progress_percent = 100, completed_at = CURRENT_TIMESTAMP WHERE video_id = ?"
                ).run(
                    path.relative(config.upload.dir, outputPath),
                    videoInfo.width,
                    videoInfo.height,
                    videoId
                );

                db.prepare('UPDATE resize_tasks SET completed_videos = completed_videos + 1 WHERE task_id = ?').run(taskId);

                emitProgress(userId, { taskId, videoId, status: 'completed', progress: 100 });

                checkResizeTaskCompletion(taskId, userId);

                console.log(`✅ Resize video ${videoId} completed`);
                return { success: true, videoId };
            } catch (err) {
                console.error(`❌ Resize video ${videoId} failed:`, err.message);

                db.prepare("UPDATE resize_videos SET status = 'failed', error_message = ? WHERE video_id = ?").run(err.message, videoId);
                db.prepare('UPDATE resize_tasks SET failed_videos = failed_videos + 1 WHERE task_id = ?').run(taskId);

                emitProgress(userId, { taskId, videoId, status: 'failed', error: err.message });

                checkResizeTaskCompletion(taskId, userId);
                throw err;
            }
        },
        {
            connection,
            concurrency: config.ffmpeg.concurrency,
            limiter: {
                max: config.ffmpeg.concurrency,
                duration: 1000,
            },
        }
    );

    worker.on('failed', (job, err) => {
        console.error(`Resize job ${job?.id} failed:`, err.message);
    });

    worker.on('error', (err) => {
        console.error('Resize worker error:', err);
    });

    console.log(`🔄 Resize worker started (concurrency: ${config.ffmpeg.concurrency})`);
    return worker;
}

function checkResizeTaskCompletion(taskId, userId) {
    const task = db.prepare('SELECT * FROM resize_tasks WHERE task_id = ?').get(taskId);
    if (!task) return;

    const totalDone = task.completed_videos + task.failed_videos;
    if (totalDone >= task.total_videos) {
        const finalStatus = task.failed_videos === task.total_videos ? 'failed' : 'completed';
        db.prepare("UPDATE resize_tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(finalStatus, taskId);

        emitProgress(userId, {
            taskId,
            status: finalStatus,
            completedVideos: task.completed_videos,
            failedVideos: task.failed_videos,
            totalVideos: task.total_videos,
        });
    }
}
