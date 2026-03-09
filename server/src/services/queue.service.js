import { Queue, Worker } from 'bullmq';
import config from '../config/index.js';
import db from '../config/database.js';
import path from 'path';
import { processVideo } from './ffmpeg.service.js';

const connection = {
    host: config.redis.host,
    port: config.redis.port,
};

// Create the video processing queue
export const videoQueue = new Queue('video-processing', {
    connection,
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
    },
});

// Socket.IO instance (set from server.js)
let io = null;
export function setSocketIO(socketIO) {
    io = socketIO;
}

function emitProgress(userId, data) {
    if (io) {
        io.to(`user:${userId}`).emit('task:progress', data);
    }
}

// Create the worker
export function startWorker() {
    const worker = new Worker(
        'video-processing',
        async (job) => {
            const { videoId, taskId, userId, inputPath, templateImagePath, template, outputPath } = job.data;

            console.log(`🎬 Processing video ${videoId} for task ${taskId}`);

            // Update video status to processing
            db.prepare("UPDATE task_videos SET status = 'processing', started_at = CURRENT_TIMESTAMP WHERE video_id = ?").run(videoId);

            // Update task status
            const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
            if (task && task.status === 'queued') {
                db.prepare("UPDATE tasks SET status = 'processing' WHERE task_id = ?").run(taskId);
            }

            emitProgress(userId, {
                taskId,
                videoId,
                status: 'processing',
                progress: 0,
            });

            try {
                await processVideo(
                    {
                        inputVideo: inputPath,
                        templateImage: templateImagePath,
                        outputPath,
                        template,
                    },
                    (percent) => {
                        // Update progress in DB
                        db.prepare('UPDATE task_videos SET progress_percent = ? WHERE video_id = ?').run(percent, videoId);

                        // Emit progress via WebSocket
                        emitProgress(userId, {
                            taskId,
                            videoId,
                            status: 'processing',
                            progress: percent,
                        });
                    }
                );

                // Mark video as completed
                db.prepare("UPDATE task_videos SET status = 'completed', output_path = ?, progress_percent = 100, completed_at = CURRENT_TIMESTAMP WHERE video_id = ?").run(
                    path.relative(config.upload.dir, outputPath),
                    videoId
                );

                // Update task counters
                db.prepare('UPDATE tasks SET completed_videos = completed_videos + 1 WHERE task_id = ?').run(taskId);

                emitProgress(userId, {
                    taskId,
                    videoId,
                    status: 'completed',
                    progress: 100,
                });

                // Check if all videos in the task are done
                checkTaskCompletion(taskId, userId);

                console.log(`✅ Video ${videoId} completed`);
                return { success: true, videoId };
            } catch (err) {
                console.error(`❌ Video ${videoId} failed:`, err.message);

                db.prepare("UPDATE task_videos SET status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE video_id = ?").run(err.message, videoId);
                db.prepare('UPDATE tasks SET failed_videos = failed_videos + 1 WHERE task_id = ?').run(taskId);

                emitProgress(userId, {
                    taskId,
                    videoId,
                    status: 'failed',
                    error: err.message,
                });

                checkTaskCompletion(taskId, userId);

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
        console.error(`Job ${job?.id} failed:`, err.message);
    });

    worker.on('error', (err) => {
        console.error('Worker error:', err);
    });

    console.log(`🚀 Video worker started (concurrency: ${config.ffmpeg.concurrency})`);
    return worker;
}

function checkTaskCompletion(taskId, userId) {
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) return;

    const totalDone = task.completed_videos + task.failed_videos;
    if (totalDone >= task.total_videos) {
        const finalStatus = task.failed_videos === task.total_videos ? 'failed' : 'completed';
        db.prepare("UPDATE tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(finalStatus, taskId);

        emitProgress(userId, {
            taskId,
            status: finalStatus,
            completedVideos: task.completed_videos,
            failedVideos: task.failed_videos,
            totalVideos: task.total_videos,
        });
    }
}
