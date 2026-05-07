/**
 * 平滑算法工具库 — Phase 1 基础版
 *
 * 提供裁切框轨迹的平滑处理：
 * - 线性插值 (lerp)
 * - 三次贝塞尔缓动插值
 * - 速度约束（最大像素/帧移动量）
 * - 关键帧序列补间
 */

/**
 * 线性插值
 * @param {number} a - 起点值
 * @param {number} b - 终点值
 * @param {number} t - 插值因子 [0, 1]
 * @returns {number}
 */
export function lerp(a, b, t) {
    return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * 三次贝塞尔缓动 ease-in-out（自然感运动曲线）
 * @param {number} t - 时间因子 [0, 1]
 * @returns {number} 缓动后的 t
 */
export function easeInOut(t) {
    t = Math.max(0, Math.min(1, t));
    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 带缓动的插值
 * @param {number} a - 起点
 * @param {number} b - 终点
 * @param {number} t - 时间因子 [0, 1]
 * @returns {number}
 */
export function easeLerp(a, b, t) {
    return lerp(a, b, easeInOut(t));
}

/**
 * 速度约束：限制相邻帧裁切框的最大移动像素数
 * @param {number} current - 当前值
 * @param {number} target - 目标值
 * @param {number} maxDelta - 最大允许变化量（像素/帧）
 * @returns {number} 约束后的值
 */
export function clampSpeed(current, target, maxDelta) {
    const delta = target - current;
    if (Math.abs(delta) <= maxDelta) return target;
    return current + Math.sign(delta) * maxDelta;
}

/**
 * 对裁切框坐标 {x, y} 应用速度约束
 * @param {{x: number, y: number}} current
 * @param {{x: number, y: number}} target
 * @param {number} maxPixelsPerFrame - 最大像素/帧
 * @returns {{x: number, y: number}}
 */
export function clampCropSpeed(current, target, maxPixelsPerFrame) {
    return {
        x: clampSpeed(current.x, target.x, maxPixelsPerFrame),
        y: clampSpeed(current.y, target.y, maxPixelsPerFrame),
    };
}

/**
 * 关键帧结构定义：
 * {
 *   frame: number,    // 帧号
 *   x: number,        // 裁切框左上角 x
 *   y: number,        // 裁切框左上角 y
 *   w: number,        // 裁切框宽度
 *   h: number,        // 裁切框高度
 * }
 */

/**
 * 在关键帧序列之间插值，生成逐帧裁切坐标
 *
 * @param {Array<{frame: number, x: number, y: number, w: number, h: number}>} keyframes
 *   排好序的关键帧数组
 * @param {number} totalFrames - 总帧数
 * @param {object} [options]
 * @param {number} [options.maxPixelsPerFrame=8] - 速度约束
 * @param {boolean} [options.useEasing=true] - 是否使用缓动插值
 * @returns {Array<{x: number, y: number, w: number, h: number}>}
 *   长度为 totalFrames 的逐帧坐标数组
 */
export function interpolateKeyframes(keyframes, totalFrames, options = {}) {
    const { maxPixelsPerFrame = 8, useEasing = true } = options;

    if (!keyframes || keyframes.length === 0) {
        throw new Error('至少需要一个关键帧');
    }

    // 只有一个关键帧：所有帧使用同一位置
    if (keyframes.length === 1) {
        const kf = keyframes[0];
        return Array.from({ length: totalFrames }, () => ({
            x: Math.round(kf.x),
            y: Math.round(kf.y),
            w: Math.round(kf.w),
            h: Math.round(kf.h),
        }));
    }

    // 按帧号排序
    const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);

    const result = [];
    const interpFn = useEasing ? easeLerp : lerp;

    for (let f = 0; f < totalFrames; f++) {
        // 找到当前帧落在哪两个关键帧之间
        let kfBefore = sorted[0];
        let kfAfter = sorted[sorted.length - 1];

        for (let i = 0; i < sorted.length - 1; i++) {
            if (f >= sorted[i].frame && f <= sorted[i + 1].frame) {
                kfBefore = sorted[i];
                kfAfter = sorted[i + 1];
                break;
            }
        }

        // 在关键帧之前：使用第一个关键帧
        if (f <= sorted[0].frame) {
            kfBefore = sorted[0];
            kfAfter = sorted[0];
        }
        // 在关键帧之后：使用最后一个关键帧
        if (f >= sorted[sorted.length - 1].frame) {
            kfBefore = sorted[sorted.length - 1];
            kfAfter = sorted[sorted.length - 1];
        }

        const span = kfAfter.frame - kfBefore.frame;
        const t = span > 0 ? (f - kfBefore.frame) / span : 0;

        let x = interpFn(kfBefore.x, kfAfter.x, t);
        let y = interpFn(kfBefore.y, kfAfter.y, t);
        const w = interpFn(kfBefore.w, kfAfter.w, t);
        const h = interpFn(kfBefore.h, kfAfter.h, t);

        // 速度约束
        if (result.length > 0 && maxPixelsPerFrame > 0) {
            const prev = result[result.length - 1];
            const clamped = clampCropSpeed(prev, { x, y }, maxPixelsPerFrame);
            x = clamped.x;
            y = clamped.y;
        }

        result.push({
            x: Math.round(x),
            y: Math.round(y),
            w: Math.round(w),
            h: Math.round(h),
        });
    }

    return result;
}

/**
 * 生成居中裁切的静态关键帧（直接裁剪模式）
 *
 * @param {number} srcW - 源视频宽度
 * @param {number} srcH - 源视频高度
 * @param {string} targetRatio - 目标比例 '1:1' | '16:9' | '9:16'
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function centerCrop(srcW, srcH, targetRatio) {
    const ratioMap = { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16 };
    const targetAR = ratioMap[targetRatio];
    if (!targetAR) throw new Error(`不支持的目标比例: ${targetRatio}`);

    const srcAR = srcW / srcH;

    let cropW, cropH;
    if (srcAR > targetAR) {
        // 源更宽 → 裁切左右
        cropH = srcH;
        cropW = Math.round(srcH * targetAR);
    } else {
        // 源更高 → 裁切上下
        cropW = srcW;
        cropH = Math.round(srcW / targetAR);
    }

    // 确保偶数（H.264 要求）
    cropW = cropW % 2 === 0 ? cropW : cropW - 1;
    cropH = cropH % 2 === 0 ? cropH : cropH - 1;

    const x = Math.round((srcW - cropW) / 2);
    const y = Math.round((srcH - cropH) / 2);

    return { x, y, w: cropW, h: cropH };
}
