import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import config from '../config/index.js';

const TEMPLATE_DIMENSIONS = {
    '1:1': { width: 1080, height: 1080 },
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
};

// H.264 / yuv420p 要求宽高必须为偶数
function toEven(n) {
    const v = Math.round(n);
    return v % 2 === 0 ? v : v + 1;
}

/**
 * Normalize template dimensions and video area to avoid invalid / legacy data.
 * 所有输出维度都保证为偶数（H.264 编码要求）。
 */
function normalizeTemplateGeometry(template) {
    const { type } = template;
    const canonical = TEMPLATE_DIMENSIONS[type] || {};
    const width = canonical.width || Number(template.width) || 1080;
    const height = canonical.height || Number(template.height) || 1920;

    let rawX = Number(template.video_area_x) || 0;
    let rawY = Number(template.video_area_y) || 0;
    let rawW = Number(template.video_area_width) || width;
    let rawH = Number(template.video_area_height) || height;

    // 修复历史遗留数据：1:1 模板 540x960 at y=60 → 540x1080 at y=0
    if (type === '1:1' && rawW === 540 && rawH === 960 && Math.abs(rawY - 60) <= 2) {
        rawY = 0;
        rawH = 1080;
    }

    const videoAreaX = Math.max(0, Math.min(Math.floor(rawX), Math.max(width - 1, 0)));
    const videoAreaY = Math.max(0, Math.min(Math.floor(rawY), Math.max(height - 1, 0)));
    const maxW = Math.max(width - videoAreaX, 1);
    const maxH = Math.max(height - videoAreaY, 1);
    const videoAreaWidth = toEven(Math.max(1, Math.min(Math.floor(rawW), maxW)));
    const videoAreaHeight = toEven(Math.max(1, Math.min(Math.floor(rawH), maxH)));

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
        '-y',
        '-i', inputVideo,
        '-i', templateImage,
    ];

    // 过扫描：视频区域向外扩展几像素，消除视频与模板边缘之间的缝隙
    const OVERSCAN = 4;
    const osX = Math.max(0, videoAreaX - OVERSCAN / 2);
    const osY = Math.max(0, videoAreaY - OVERSCAN / 2);
    const osW = toEven(Math.min(videoAreaWidth + OVERSCAN, width - osX));
    const osH = toEven(Math.min(videoAreaHeight + OVERSCAN, height - osY));

    let filterComplex;

    if (type === '9:16') {
        filterComplex = [
            `[0:v]scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1[src]`,
            `[src]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[video]`,
            `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba[template]`,
            `[video][template]overlay=0:0:format=auto,setsar=1,setdar=${width}/${height}[outv]`,
        ].join(';');
    } else {
        // 1:1 或 16:9：模糊背景 + 视频区域 + 模板叠加
        filterComplex = [
            `[0:v]scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1,split=2[bg_src][video_src]`,
            // 模糊背景：先裁剪到画布尺寸，缩小 10 倍做高斯模糊再放大（节省 90% 算力）
            `[bg_src]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},scale=w=trunc(iw/20)*2:h=trunc(ih/20)*2,gblur=sigma=10,scale=${width}:${height}:flags=fast_bilinear[bg]`,
            // 视频缩放到过扫描尺寸（比标注区域略大），消除边缘缝隙
            `[video_src]scale=${osW}:${osH}:force_original_aspect_ratio=increase,crop=${osW}:${osH}[scaled_video]`,
            `[bg][scaled_video]overlay=${osX}:${osY}[with_video]`,
            `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba[template]`,
            `[with_video][template]overlay=0:0:format=auto,setsar=1,setdar=${width}/${height}[outv]`,
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
        // 校验模板图片是否存在
        if (!fs.existsSync(templateImage)) {
            return reject(new Error(`模板图片不存在: ${templateImage}`));
        }

        const expected = TEMPLATE_DIMENSIONS[template.type];
        if (expected) {
            const actual = readImageDimensions(templateImage);
            if (!actual || actual.width !== expected.width || actual.height !== expected.height) {
                return reject(new Error(
                    `模板尺寸异常: type=${template.type} 期望 ${expected.width}x${expected.height}，实际 ${actual ? `${actual.width}x${actual.height}` : '无法读取'}`
                ));
            }
        }

        // 校验输入视频是否存在
        if (!fs.existsSync(inputVideo)) {
            return reject(new Error(`输入视频不存在: ${inputVideo}`));
        }

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

        function runFFmpeg(duration) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });

            const args = buildFFmpegArgs({ inputVideo, templateImage, outputPath, template });

            console.log(`[FFmpeg] type=${template.type} cmd: ffmpeg ${args.join(' ')}`);

            const ffmpeg = spawn('ffmpeg', args);
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();

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
                    console.error(`[FFmpeg] FAILED type=${template.type} code=${code}\n${stderr.slice(-1000)}`);
                    reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`FFmpeg spawn error: ${err.message}`));
            });

            const timeout = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                reject(new Error('FFmpeg processing timeout'));
            }, config.ffmpeg.timeout);

            ffmpeg.on('close', () => clearTimeout(timeout));
        }

        probe.on('close', () => {
            const duration = parseFloat(durationStr.trim()) || 0;
            runFFmpeg(duration);
        });

        probe.on('error', () => {
            runFFmpeg(0);
        });
    });
}
