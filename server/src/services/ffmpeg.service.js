import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import config from '../config/index.js';

const TEMPLATE_DIMENSIONS = {
    '1:1': { width: 1080, height: 1080 },
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
};

/**
 * Normalize template dimensions and video area to avoid invalid / legacy data.
 * @param {Object} template
 * @returns {{
 *   width:number,
 *   height:number,
 *   videoAreaX:number,
 *   videoAreaY:number,
 *   videoAreaWidth:number,
 *   videoAreaHeight:number
 * }}
 */
function normalizeTemplateGeometry(template) {
    const { type } = template;
    // 强制使用标准尺寸，避免历史错误数据把 9:16 输出成 16:9。
    const canonical = TEMPLATE_DIMENSIONS[type] || {};
    const width = canonical.width || Number(template.width) || 1080;
    const height = canonical.height || Number(template.height) || 1920;

    const rawX = Number(template.video_area_x) || 0;
    const rawY = Number(template.video_area_y) || 0;
    const rawW = Number(template.video_area_width) || width;
    const rawH = Number(template.video_area_height) || height;

    const videoAreaX = Math.max(0, Math.min(Math.floor(rawX), Math.max(width - 1, 0)));
    const videoAreaY = Math.max(0, Math.min(Math.floor(rawY), Math.max(height - 1, 0)));
    const maxW = Math.max(width - videoAreaX, 1);
    const maxH = Math.max(height - videoAreaY, 1);
    const videoAreaWidth = Math.max(1, Math.min(Math.floor(rawW), maxW));
    const videoAreaHeight = Math.max(1, Math.min(Math.floor(rawH), maxH));

    return { width, height, videoAreaX, videoAreaY, videoAreaWidth, videoAreaHeight };
}

/**
 * Read image dimensions via ffprobe.
 * @param {string} imagePath
 * @returns {{width:number,height:number}|null}
 */
function readImageDimensions(imagePath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=s=x:p=0',
        imagePath,
    ], { encoding: 'utf-8' });

    if (probe.status !== 0 || !probe.stdout) return null;
    const [w, h] = probe.stdout.trim().split('x');
    const width = Number(w);
    const height = Number(h);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

/**
 * Generate FFmpeg command for compositing video with template
 * @param {Object} params
 * @param {string} params.inputVideo - Path to input 9:16 video
 * @param {string} params.templateImage - Path to template PNG (with alpha)
 * @param {string} params.outputPath - Path to output video
 * @param {Object} params.template - Template metadata from DB
 * @returns {Object} { args: string[], outputPath: string }
 */
export function buildFFmpegArgs({ inputVideo, templateImage, outputPath, template }) {
    const { type } = template;
    const { width, height, videoAreaX, videoAreaY, videoAreaWidth, videoAreaHeight } = normalizeTemplateGeometry(template);

    const args = [
        '-y', // Overwrite output
        '-i', inputVideo,
        '-i', templateImage,
    ];

    let filterComplex;

    if (type === '9:16') {
        // Template C: Fill the whole canvas without black bars (cover mode).
        // We enlarge first, then center-crop to target size.
        filterComplex = [
            // Normalize source SAR first to avoid unexpected stretching on mobile players.
            `[0:v]scale=iw*sar:ih,setsar=1[src]`,
            `[src]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[video]`,
            // Align template to target canvas while keeping aspect ratio (avoid template stretching).
            `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba[template]`,
            // 显式设置 SAR / DAR，避免播放器把竖版误识别成横版。
            `[video][template]overlay=0:0:format=auto,scale=${width}:${height}:flags=lanczos,setsar=1,setdar=${width}/${height}[outv]`,
        ].join(';');
    } else {
        // Template A (1:1) or Template B (16:9): Place video behind template
        filterComplex = [
            // Normalize source SAR first to avoid unexpected stretching on mobile players.
            `[0:v]scale=iw*sar:ih,setsar=1[src]`,
            // 先做一层铺满的模糊背景，避免出现黑边。
            `[src]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=25:12[bg]`,
            // Fill designated area without black bars (cover mode).
            `[src]scale=${videoAreaWidth}:${videoAreaHeight}:force_original_aspect_ratio=increase,crop=${videoAreaWidth}:${videoAreaHeight}[scaled_video]`,
            // Place video on canvas at designated position
            `[bg][scaled_video]overlay=${videoAreaX}:${videoAreaY}:shortest=1[with_video]`,
            // Align template to target canvas while keeping aspect ratio (avoid template stretching).
            `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba[template]`,
            // Overlay template (with transparency) on top
            `[with_video][template]overlay=0:0:format=auto,scale=${width}:${height}:flags=lanczos,setsar=1,setdar=${width}/${height}[outv]`,
        ].join(';');
    }

    args.push(
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-threads', '2',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-map_metadata', '-1',
        '-metadata:s:v:0', 'rotate=0',
        // 删除 H.264 的方向 side-data，防止部分播放器把竖版误显示成横版。
        '-bsf:v', 'h264_metadata=display_orientation=remove',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-shortest',
        outputPath
    );

    return args;
}

/**
 * Process a single video with FFmpeg
 * @param {Object} params - Same as buildFFmpegArgs
 * @param {Function} onProgress - Progress callback (percent: number)
 * @returns {Promise<string>} Output file path
 */
export function processVideo({ inputVideo, templateImage, outputPath, template }, onProgress) {
    return new Promise((resolve, reject) => {
        const expected = TEMPLATE_DIMENSIONS[template.type];
        if (expected) {
            const actual = readImageDimensions(templateImage);
            // 运行时兜底校验：防止历史脏数据导致模板类型与图片尺寸不一致。
            if (!actual || actual.width !== expected.width || actual.height !== expected.height) {
                return reject(new Error(
                    `模板尺寸异常: type=${template.type} 期望 ${expected.width}x${expected.height}，实际 ${actual ? `${actual.width}x${actual.height}` : '无法读取'}`
                ));
            }
        }

        // First, get video duration for progress calculation
        const probeArgs = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'csv=p=0',
            inputVideo
        ];

        const probe = spawn('ffprobe', probeArgs);
        let durationStr = '';

        probe.stdout.on('data', (data) => {
            durationStr += data.toString();
        });

        probe.on('close', (code) => {
            const duration = parseFloat(durationStr.trim()) || 0;

            // Ensure output directory exists
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });

            const args = buildFFmpegArgs({ inputVideo, templateImage, outputPath, template });

            const ffmpeg = spawn('ffmpeg', args);
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();

                // Parse progress from stderr
                if (duration > 0 && onProgress) {
                    const timeMatch = data.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
                    if (timeMatch) {
                        const currentTime =
                            parseInt(timeMatch[1]) * 3600 +
                            parseInt(timeMatch[2]) * 60 +
                            parseInt(timeMatch[3]) +
                            parseInt(timeMatch[4]) / 100;
                        const percent = Math.min(Math.round((currentTime / duration) * 100), 99);
                        onProgress(percent);
                    }
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    onProgress && onProgress(100);
                    resolve(outputPath);
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`FFmpeg spawn error: ${err.message}`));
            });

            // Timeout
            const timeout = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                reject(new Error('FFmpeg processing timeout'));
            }, config.ffmpeg.timeout);

            ffmpeg.on('close', () => clearTimeout(timeout));
        });

        probe.on('error', () => {
            // If ffprobe fails, proceed without duration (no progress)
            const args = buildFFmpegArgs({ inputVideo, templateImage, outputPath, template });
            const ffmpeg = spawn('ffmpeg', args);
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    onProgress && onProgress(100);
                    resolve(outputPath);
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
                }
            });

            ffmpeg.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
        });
    });
}
