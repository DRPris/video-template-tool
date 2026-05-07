"""
裁切路径生成器 - 分析视频并生成逐帧裁切坐标

流程:
1. 按分析帧率采样视频帧
2. 场景检测（人脸 + 光流 + 显著性）
3. 生成原始 ROI 路径
4. 三层平滑处理
5. 转换为像素坐标输出
"""
import cv2
import numpy as np
from typing import List, Dict, Optional, Tuple, Any
from dataclasses import asdict
import json
import time

from scene_detector import SceneDetector, FrameAnalysis
from smoother import smooth_pipeline
import config


# 目标尺寸映射
TARGET_DIMS = {
    "1:1": (1080, 1080),
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
}


def generate_crop_path(
    video_path: str,
    target_ratio: str,
    user_keyframes: Optional[List[Dict]] = None,
    progress_callback=None,
) -> Dict[str, Any]:
    """
    分析视频，生成智能裁切路径

    Args:
        video_path: 视频文件路径
        target_ratio: 目标比例 "1:1" / "16:9" / "9:16"
        user_keyframes: 用户标注的关键帧 [{"frame": int, "x": float, "y": float}, ...]
        progress_callback: 进度回调 fn(percent: int)

    Returns:
        {
            "video_info": { width, height, fps, total_frames, duration },
            "target": { width, height, ratio },
            "scene_summary": { dominant_scene, scene_counts, ... },
            "crop_path": [
                { "frame": 0, "x": 420, "y": 0, "w": 1080, "h": 1920 },
                ...
            ],
            "keyframes": [  # AI 推荐关键帧（供用户编辑）
                { "frame": 0, "x": 0.5, "y": 0.3, "scene": "single_face", "auto": true },
                ...
            ],
            "analysis_time": 1.23,
        }
    """
    t0 = time.time()
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"无法打开视频: {video_path}")

    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0

    tgt_w, tgt_h = TARGET_DIMS.get(target_ratio, (1080, 1080))

    # 计算裁切窗口尺寸（在原视频坐标系下）
    crop_w, crop_h = _compute_crop_window(src_w, src_h, tgt_w, tgt_h)

    # 采样帧率
    sample_interval = max(1, int(fps / config.MAX_ANALYSIS_FPS))

    # 场景检测器
    detector = SceneDetector()
    detector.reset()

    # 逐帧分析
    analyses: List[FrameAnalysis] = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_interval == 0:
            analysis = detector.analyze_frame(frame, frame_idx, fps)
            analyses.append(analysis)

            if progress_callback and total_frames > 0:
                pct = min(80, int(frame_idx / total_frames * 80))
                progress_callback(pct)

        frame_idx += 1

    cap.release()

    if not analyses:
        raise ValueError("视频分析失败：未获取到任何帧")

    # 场景统计
    scene_counts = {}
    for a in analyses:
        scene_counts[a.scene_type] = scene_counts.get(a.scene_type, 0) + 1
    dominant_scene = max(scene_counts, key=scene_counts.get)

    # 生成原始 ROI 中心路径（采样帧）
    raw_centers = []
    for a in analyses:
        if a.primary_roi:
            raw_centers.append((a.primary_roi[0], a.primary_roi[1]))
        else:
            raw_centers.append((0.5, 0.5))

    # 上采样到全帧率
    full_raw = _upsample_to_full(raw_centers, analyses, total_frames)

    # 用户关键帧转换
    kf_list = None
    if user_keyframes:
        kf_list = [(kf["frame"], kf["x"], kf["y"]) for kf in user_keyframes]

    # 三层平滑
    if progress_callback:
        progress_callback(85)

    smoothed = smooth_pipeline(
        full_raw,
        keyframes=kf_list,
        frame_w=src_w,
        frame_h=src_h,
    )

    if progress_callback:
        progress_callback(90)

    # 转换为像素坐标裁切框
    crop_path = []
    ai_keyframes = []

    # 每 N 帧输出一个关键帧（用于前端可视化）
    kf_interval = max(1, int(fps * 2))  # 每 2 秒一个关键帧

    for i, (cx, cy) in enumerate(smoothed):
        # 中心点 → 左上角
        px = cx * src_w - crop_w / 2
        py = cy * src_h - crop_h / 2

        # 约束在画面内
        px = max(0, min(src_w - crop_w, px))
        py = max(0, min(src_h - crop_h, py))

        crop_path.append({
            "frame": i,
            "x": int(round(px)),
            "y": int(round(py)),
            "w": crop_w,
            "h": crop_h,
        })

        # 标记关键帧
        if i % kf_interval == 0 or i == total_frames - 1:
            # 找到最近的分析帧来获取场景类型
            nearest = min(analyses, key=lambda a: abs(a.frame_idx - i))
            ai_keyframes.append({
                "frame": i,
                "x": float(cx),
                "y": float(cy),
                "scene": nearest.scene_type,
                "auto": True,
            })

    if progress_callback:
        progress_callback(100)

    return {
        "video_info": {
            "width": src_w,
            "height": src_h,
            "fps": round(fps, 2),
            "total_frames": total_frames,
            "duration": round(duration, 2),
        },
        "target": {
            "width": tgt_w,
            "height": tgt_h,
            "ratio": target_ratio,
        },
        "scene_summary": {
            "dominant_scene": dominant_scene,
            "scene_counts": scene_counts,
            "total_analyzed_frames": len(analyses),
        },
        "crop_path": crop_path,
        "keyframes": ai_keyframes,
        "analysis_time": round(time.time() - t0, 2),
    }


def _compute_crop_window(
    src_w: int, src_h: int,
    tgt_w: int, tgt_h: int,
) -> Tuple[int, int]:
    """
    计算在源视频上的裁切窗口尺寸，保持目标宽高比，尽可能大
    """
    target_aspect = tgt_w / tgt_h
    src_aspect = src_w / src_h

    if target_aspect > src_aspect:
        # 目标更宽 → 以宽度为准
        crop_w = src_w
        crop_h = int(src_w / target_aspect)
    else:
        # 目标更高 → 以高度为准
        crop_h = src_h
        crop_w = int(src_h * target_aspect)

    # 确保偶数（FFmpeg 要求）
    crop_w = crop_w - (crop_w % 2)
    crop_h = crop_h - (crop_h % 2)

    return (crop_w, crop_h)


def _upsample_to_full(
    sampled: List[Tuple[float, float]],
    analyses: List[FrameAnalysis],
    total_frames: int,
) -> List[Tuple[float, float]]:
    """将采样帧结果上采样到全帧率（线性插值）"""
    if not sampled:
        return [(0.5, 0.5)] * total_frames

    if len(sampled) == 1:
        return [sampled[0]] * total_frames

    # 创建采样帧索引到值的映射
    sample_indices = [a.frame_idx for a in analyses]

    result = []
    for i in range(total_frames):
        # 找到前后最近的采样帧
        left_idx = 0
        for j, si in enumerate(sample_indices):
            if si <= i:
                left_idx = j
            else:
                break

        right_idx = min(left_idx + 1, len(sampled) - 1)

        if left_idx == right_idx:
            result.append(sampled[left_idx])
        else:
            # 线性插值
            li = sample_indices[left_idx]
            ri = sample_indices[right_idx]
            t = (i - li) / (ri - li) if ri > li else 0

            lx, ly = sampled[left_idx]
            rx, ry = sampled[right_idx]
            result.append((lx + (rx - lx) * t, ly + (ry - ly) * t))

    return result
