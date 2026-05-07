import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import config from '../config/index.js';
import { centerCrop, interpolateKeyframes } from '../utils/smooth.js';

const TARGET_DIMENSIONS = {
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
 * 通过 ffprobe 获取视频的宽、高、帧率、总帧数、时长
 * @param {string} videoPath
 * @returns {{width:number, height:number, fps:number, totalFrames:number, duration:number}|null}
 */
export function probeVideo(videoPath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        videoPath,
    ], { encoding: 'utf-8', timeout: 15000 });

    if (probe.status !== 0 || !probe.stdout) return null;

    try {
        const data = JSON.parse(probe.stdout);
        const stream = data.streams?.[0];
        if (!stream) return null;

        const width = Number(stream.width);
        const height = Number(stream.height);

        // 解析帧率 (如 "30000/1001" → 29.97)
        let fps = 30;
        if (stream.r_frame_rate) {
            const parts = stream.r_frame_rate.split('/');
            fps = parts.length === 2
                ? Number(parts[0]) / Number(parts[1])
                : Number(parts[0]);
        }
        fps = Number.isFinite(fps) && fps > 0 ? fps : 30;

        // 时长
        const duration = Number(stream.duration) || Number(data.format?.duration) || 0;

        // 总帧数
        let totalFrames = Number(stream.nb_frames);
        if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
            totalFrames = Math.round(duration * fps);
        }

        return { width, height, fps, totalFrames, duration };
    } catch {
        return null;
    }
}

/**
 * 判断源→目标的转换是否需要"外扩"（源画面不够大）
 */
export function needsOutpaint(srcW, srcH, targetRatio) {
    const targetAR = { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16 }[targetRatio];
    const srcAR = srcW / srcH;
    // 竖版→横版 或 竖版→方形：源宽度不够
    if (srcAR < targetAR && targetAR > 1) return true;
    // 更精确：如果裁切后尺寸会小于目标分辨率的 50%
    return false;
}

/**
 * 构建静态居中裁切的 FFmpeg 参数（直接裁剪模式）
 *
 * @param {object} params
 * @param {string} params.inputVideo
 * @param {string} params.outputPath
 * @param {string} params.targetRatio - '1:1' | '16:9' | '9:16'
 * @param {object} params.videoInfo - probeVideo 返回值
 * @returns {string[]} FFmpeg 参数数组
 */
export function buildCenterCropArgs({ inputVideo, outputPath, targetRatio, videoInfo }) {
    const target = TARGET_DIMENSIONS[targetRatio];
    const { width: srcW, height: srcH } = videoInfo;
    const srcAR = srcW / srcH;
    const targetAR = target.width / target.height;

    let filterComplex;

    // 判断是否需要外扩方案（源画面比目标更窄/更短）
    const useBlurBg = (srcAR < targetAR - 0.01);

    // 判断是否需要显著放大（裁切后实际像素远小于目标分辨率）
    // 用于 16:9→9:16 等场景，裁切后宽度从 1920 截到 ~608，需要放大到 1080
    const cropW = useBlurBg ? srcW : Math.min(srcW, Math.round(srcH * targetAR));
    const needsUpscale = cropW < target.width * 0.9;
    // 锐化参数：针对放大场景恢复细节，luma_amount=1.2 适度锐化不会产生白边
    const unsharpFilter = needsUpscale ? ',unsharp=5:5:1.2:5:5:0.8' : '';

    if (useBlurBg) {
        // 模糊背景 + 居中视频的安全方案
        // 用于 9:16→16:9, 9:16→1:1 等画面不够的场景
        const fitH = target.height;
        const fitW = toEven(Math.round(fitH * srcAR));

        filterComplex = [
            // SAR 归一化
            `[0:v]scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1,split=2[bg_src][vid_src]`,
            // 模糊背景层
            `[bg_src]scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height},scale=w=trunc(iw/20)*2:h=trunc(ih/20)*2,gblur=sigma=12,scale=${target.width}:${target.height}:flags=fast_bilinear[bg]`,
            // 清晰视频层：保持比例缩放到目标高度，使用 lanczos 高质量缩放 + 锐化
            `[vid_src]scale=${fitW}:${fitH}:flags=lanczos:force_original_aspect_ratio=decrease${unsharpFilter}[vid]`,
            // 叠加居中
            `[bg][vid]overlay=(W-w)/2:(H-h)/2,setsar=1,setdar=${target.width}/${target.height}[outv]`,
        ].join(';');
    } else {
        // 正常裁切：源画面足够，居中裁切到目标比例再缩放
        // 使用 lanczos 算法缩放 + 条件锐化
        filterComplex = [
            `[0:v]scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1[normalized]`,
            `[normalized]scale=${target.width}:${target.height}:flags=lanczos:force_original_aspect_ratio=increase,crop=${target.width}:${target.height}${unsharpFilter},setsar=1,setdar=${target.width}/${target.height}[outv]`,
        ].join(';');
    }

    return [
        '-y',
        '-i', inputVideo,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-threads', '4',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-map_metadata', '-1',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-shortest',
        outputPath,
    ];
}

/**
 * 构建基于裁切路径的动态裁切 FFmpeg 参数
 * 使用 crop 表达式实现逐关键帧线性插值裁切
 *
 * @param {object} params
 * @param {string} params.inputVideo
 * @param {string} params.outputPath
 * @param {string} params.targetRatio
 * @param {object} params.videoInfo
 * @param {Array} params.keyframes - crop_path 数组 [{frame, x, y, w, h}, ...]
 * @returns {string[]} FFmpeg 参数数组
 */
export function buildDynamicCropArgs({ inputVideo, outputPath, targetRatio, videoInfo, keyframes }) {
    const target = TARGET_DIMENSIONS[targetRatio];
    const { fps, width: srcW, height: srcH } = videoInfo;

    // 确定裁切窗口尺寸
    const cropW = keyframes[0]?.w || Math.min(srcW, Math.round(srcH * (target.width / target.height)));
    const cropH = keyframes[0]?.h || Math.min(srcH, Math.round(srcW * (target.height / target.width)));

    // 抽样关键帧用于构建表达式（每秒 2 个关键帧，避免表达式过长）
    const sampleInterval = Math.max(1, Math.round(fps / 2));
    const sampledKFs = [];
    for (let i = 0; i < keyframes.length; i += sampleInterval) {
        const kf = keyframes[i];
        sampledKFs.push({
            t: kf.frame / fps,
            x: Math.max(0, Math.min(srcW - cropW, kf.x)),
            y: Math.max(0, Math.min(srcH - cropH, kf.y)),
        });
    }
    // 确保最后一帧在内
    const lastKf = keyframes[keyframes.length - 1];
    const lastT = lastKf.frame / fps;
    if (!sampledKFs.length || sampledKFs[sampledKFs.length - 1].t < lastT) {
        sampledKFs.push({
            t: lastT,
            x: Math.max(0, Math.min(srcW - cropW, lastKf.x)),
            y: Math.max(0, Math.min(srcH - cropH, lastKf.y)),
        });
    }

    // 构建 crop 表达式：使用 if(between(t,...)) 分段线性
    const xExpr = _buildSegmentExpr(sampledKFs, 'x');
    const yExpr = _buildSegmentExpr(sampledKFs, 'y');

    // 判断是否需要显著放大
    const needsUpscale = cropW < target.width * 0.9;
    const unsharpFilter = needsUpscale ? ',unsharp=5:5:1.2:5:5:0.8' : '';

    const filterComplex = [
        `[0:v]scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1[normalized]`,
        `[normalized]crop=${cropW}:${cropH}:${xExpr}:${yExpr},scale=${target.width}:${target.height}:flags=lanczos${unsharpFilter},setsar=1,setdar=${target.width}/${target.height}[outv]`,
    ].join(';');

    return [
        '-y',
        '-i', inputVideo,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-threads', '4',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-map_metadata', '-1',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-shortest',
        outputPath,
    ];
}

/**
 * 构建分段线性插值的 FFmpeg 表达式
 * 输出类似: if(between(t,0,1),lerp(v0,v1,t,0,1),if(between(t,1,2),...,vN))
 */
function _buildSegmentExpr(kfs, prop) {
    if (kfs.length === 0) return '0';
    if (kfs.length === 1) return String(Math.round(kfs[0][prop]));

    // 限制表达式长度（FFmpeg 有表达式长度限制）
    // 如果关键帧太多，进一步抽样
    let usedKFs = kfs;
    if (kfs.length > 30) {
        const step = Math.ceil(kfs.length / 30);
        usedKFs = kfs.filter((_, i) => i % step === 0 || i === kfs.length - 1);
    }

    // 构建嵌套 if 表达式
    let expr = String(Math.round(usedKFs[usedKFs.length - 1][prop]));

    for (let i = usedKFs.length - 2; i >= 0; i--) {
        const t0 = usedKFs[i].t.toFixed(3);
        const t1 = usedKFs[i + 1].t.toFixed(3);
        const v0 = Math.round(usedKFs[i][prop]);
        const v1 = Math.round(usedKFs[i + 1][prop]);

        if (v0 === v1) {
            // 值没变化，不需要插值
            expr = `if(between(t\\,${t0}\\,${t1})\\,${v0}\\,${expr})`;
        } else {
            // 线性插值: v0 + (v1-v0) * (t-t0) / (t1-t0)
            const duration = (parseFloat(t1) - parseFloat(t0)).toFixed(3);
            expr = `if(between(t\\,${t0}\\,${t1})\\,${v0}+${v1 - v0}*(t-${t0})/${duration}\\,${expr})`;
        }
    }

    return `'${expr}'`;
}

/**
 * 执行视频 Resize 处理
 *
 * @param {object} params
 * @param {string} params.inputVideo
 * @param {string} params.outputPath
 * @param {string} params.targetRatio
 * @param {string} params.mode - 'center' | 'smart'
 * @param {Array} [params.keyframes] - 智能模式的关键帧
 * @param {Function} [onProgress]
 * @returns {Promise<{outputPath: string, videoInfo: object}>}
 */
export function processResize({ inputVideo, outputPath, targetRatio, mode, keyframes }, onProgress) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(inputVideo)) {
            return reject(new Error(`输入视频不存在: ${inputVideo}`));
        }

        const videoInfo = probeVideo(inputVideo);
        if (!videoInfo) {
            return reject(new Error(`无法读取视频信息: ${inputVideo}`));
        }

        console.log(`[Resize] 源视频: ${videoInfo.width}x${videoInfo.height} @ ${videoInfo.fps}fps, ${videoInfo.duration}s`);
        console.log(`[Resize] 目标比例: ${targetRatio}, 模式: ${mode}`);

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        let args;
        if (mode === 'smart' && keyframes && keyframes.length > 0) {
            args = buildDynamicCropArgs({ inputVideo, outputPath, targetRatio, videoInfo, keyframes });
        } else {
            args = buildCenterCropArgs({ inputVideo, outputPath, targetRatio, videoInfo });
        }

        console.log(`[Resize] ffmpeg ${args.join(' ')}`);

        const ffmpeg = spawn('ffmpeg', args);
        let stderr = '';

        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
            if (videoInfo.duration > 0 && onProgress) {
                const timeMatch = data.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
                if (timeMatch) {
                    const currentTime =
                        parseInt(timeMatch[1]) * 3600 +
                        parseInt(timeMatch[2]) * 60 +
                        parseInt(timeMatch[3]) +
                        parseInt(timeMatch[4]) / 100;
                    const percent = Math.min(Math.round((currentTime / videoInfo.duration) * 100), 99);
                    onProgress(percent);
                }
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                onProgress && onProgress(100);
                resolve({ outputPath, videoInfo });
            } else {
                console.error(`[Resize] FAILED code=${code}\n${stderr.slice(-1000)}`);
                reject(new Error(`FFmpeg resize failed (code ${code}): ${stderr.slice(-500)}`));
            }
        });

        ffmpeg.on('error', (err) => {
            reject(new Error(`FFmpeg spawn error: ${err.message}`));
        });

        const timeout = setTimeout(() => {
            ffmpeg.kill('SIGKILL');
            reject(new Error('Resize processing timeout'));
        }, config.ffmpeg.timeout);

        ffmpeg.on('close', () => clearTimeout(timeout));
    });
}
