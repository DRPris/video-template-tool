"""
场景检测器 - 结合人脸检测、光流和显著性分析判断场景类型

场景类型：
  - single_face:  单人出镜 → 人脸追踪策略
  - multi_face:   多人对话 → 显著性图 + 缓慢扫视
  - motion:       运动场景 → 主体追踪 + 预测缓冲区
  - static:       静态场景 → 居中裁切
"""
import os
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision
from dataclasses import dataclass, field
from typing import List, Tuple, Optional
from collections import deque
import config


@dataclass
class FaceInfo:
    """检测到的人脸信息"""
    bbox: Tuple[float, float, float, float]  # (x, y, w, h) 归一化坐标
    confidence: float


@dataclass
class FrameAnalysis:
    """单帧分析结果"""
    frame_idx: int
    timestamp: float           # 秒
    scene_type: str            # single_face / multi_face / motion / static
    faces: List[FaceInfo] = field(default_factory=list)
    saliency_center: Optional[Tuple[float, float]] = None  # 显著性中心 (归一化)
    motion_magnitude: float = 0.0     # 平均光流大小
    primary_roi: Optional[Tuple[float, float, float, float]] = None  # 推荐裁切区 (x, y, w, h) 归一化


class SceneDetector:
    """场景检测器 - 综合人脸、运动和显著性分析"""

    def __init__(self):
        # MediaPipe Face Detection (Tasks API)
        model_path = os.path.join(
            os.path.dirname(__file__), "models", "blaze_face_short_range.tflite"
        )
        base_options = BaseOptions(model_asset_path=model_path)
        options = vision.FaceDetectorOptions(
            base_options=base_options,
            min_detection_confidence=config.FACE_DETECTION_CONFIDENCE,
        )
        self.face_detector = vision.FaceDetector.create_from_options(options)

        # OpenCV 显著性检测
        self.saliency = cv2.saliency.StaticSaliencyFineGrained_create()

        # 光流缓存
        self._prev_gray = None

        # ---- 场景类型稳定 ----
        # 滑动窗口记录最近 N 帧的场景类型
        self._scene_history = deque(maxlen=config.SCENE_STABLE_WINDOW)
        self._current_stable_scene = "static"  # 当前稳定场景类型

        # ---- 显著性 EMA 平滑 ----
        self._sal_ema_x = 0.5
        self._sal_ema_y = 0.5
        self._sal_initialized = False

    def analyze_frame(self, frame: np.ndarray, frame_idx: int, fps: float) -> FrameAnalysis:
        """分析单帧，返回场景类型和 ROI"""
        h, w = frame.shape[:2]
        timestamp = frame_idx / fps if fps > 0 else 0.0

        # 1. 人脸检测
        faces = self._detect_faces(frame)

        # 2. 光流（运动检测）
        motion_mag = self._compute_motion(frame)

        # 3. 显著性检测（带 EMA 平滑）
        sal_center = self._compute_saliency_smooth(frame)

        # 4. 场景分类（带时间稳定）
        raw_scene = self._classify_scene_raw(faces, motion_mag)
        scene_type = self._stabilize_scene(raw_scene)

        # 5. 计算推荐 ROI
        primary_roi = self._compute_roi(faces, sal_center, motion_mag, scene_type, w, h)

        return FrameAnalysis(
            frame_idx=frame_idx,
            timestamp=timestamp,
            scene_type=scene_type,
            faces=faces,
            saliency_center=sal_center,
            motion_magnitude=motion_mag,
            primary_roi=primary_roi,
        )

    def _detect_faces(self, frame: np.ndarray) -> List[FaceInfo]:
        """使用 MediaPipe Tasks API 检测人脸"""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self.face_detector.detect(mp_image)
        faces = []

        if result.detections:
            h, w = frame.shape[:2]
            for det in result.detections:
                bbox = det.bounding_box
                # bbox is in pixel coordinates, normalize
                nx = max(0, bbox.origin_x / w)
                ny = max(0, bbox.origin_y / h)
                nw = min(1 - nx, bbox.width / w)
                nh = min(1 - ny, bbox.height / h)
                score = det.categories[0].score if det.categories else 0.0
                faces.append(FaceInfo(bbox=(nx, ny, nw, nh), confidence=score))

        return faces

    def _compute_motion(self, frame: np.ndarray) -> float:
        """基于光流计算运动强度"""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, (320, 180))  # 缩小加速

        if self._prev_gray is None:
            self._prev_gray = gray
            return 0.0

        flow = cv2.calcOpticalFlowFarneback(
            self._prev_gray, gray,
            None, 0.5, 3, 15, 3, 5, 1.2, 0
        )
        self._prev_gray = gray

        mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
        return float(np.mean(mag))

    def _compute_saliency_smooth(self, frame: np.ndarray) -> Optional[Tuple[float, float]]:
        """计算显著性中心，并用 EMA 平滑帧间抖动"""
        raw_center = self._compute_saliency_raw(frame)
        if raw_center is None:
            return (self._sal_ema_x, self._sal_ema_y) if self._sal_initialized else (0.5, 0.5)

        rx, ry = raw_center

        if not self._sal_initialized:
            self._sal_ema_x = rx
            self._sal_ema_y = ry
            self._sal_initialized = True
        else:
            # EMA 平滑: 越小的 alpha 越平滑
            alpha = 0.15
            self._sal_ema_x = alpha * rx + (1 - alpha) * self._sal_ema_x
            self._sal_ema_y = alpha * ry + (1 - alpha) * self._sal_ema_y

        return (self._sal_ema_x, self._sal_ema_y)

    def _compute_saliency_raw(self, frame: np.ndarray) -> Optional[Tuple[float, float]]:
        """计算原始显著性中心（无平滑）"""
        small = cv2.resize(frame, (256, 144))
        success, sal_map = self.saliency.computeSaliency(small)

        if not success or sal_map is None:
            return None

        sal_map = (sal_map * 255).astype(np.uint8)
        # 高斯模糊平滑
        sal_map = cv2.GaussianBlur(sal_map, (21, 21), 0)

        # 找到加权质心
        h, w = sal_map.shape
        total = np.sum(sal_map).astype(np.float64)
        if total < 1:
            return (0.5, 0.5)

        y_coords, x_coords = np.mgrid[0:h, 0:w]
        cx = np.sum(x_coords * sal_map) / total / w
        cy = np.sum(y_coords * sal_map) / total / h

        return (float(np.clip(cx, 0, 1)), float(np.clip(cy, 0, 1)))

    def _classify_scene_raw(self, faces: List[FaceInfo], motion_mag: float) -> str:
        """原始场景分类（单帧）"""
        num_faces = len(faces)

        if num_faces == config.SCENE_SINGLE_FACE_THRESHOLD:
            return "single_face"
        elif num_faces >= config.SCENE_MULTI_FACE_THRESHOLD:
            return "multi_face"
        elif motion_mag > config.MOTION_THRESHOLD:
            return "motion"
        else:
            return "static"

    def _stabilize_scene(self, raw_scene: str) -> str:
        """
        场景类型时间稳定：只有连续 N 帧中多数投票为同一场景时才切换。
        避免场景类型在帧间跳变导致 ROI 策略跳变。
        """
        self._scene_history.append(raw_scene)

        if len(self._scene_history) < config.SCENE_STABLE_WINDOW:
            # 窗口未填满，保持当前稳定场景
            return self._current_stable_scene

        # 多数投票
        counts = {}
        for s in self._scene_history:
            counts[s] = counts.get(s, 0) + 1
        majority = max(counts, key=counts.get)

        # 只有多数超过 60% 才切换
        if counts[majority] >= config.SCENE_STABLE_WINDOW * 0.6:
            self._current_stable_scene = majority

        return self._current_stable_scene

    def _compute_roi(
        self,
        faces: List[FaceInfo],
        sal_center: Optional[Tuple[float, float]],
        motion_mag: float,
        scene_type: str,
        frame_w: int,
        frame_h: int,
    ) -> Tuple[float, float, float, float]:
        """根据场景类型计算推荐 ROI (归一化 x, y, w, h)"""

        if scene_type == "single_face" and faces:
            face = faces[0]
            fx = face.bbox[0] + face.bbox[2] / 2
            fy = face.bbox[1] + face.bbox[3] / 2
            fy = fy - face.bbox[3] * 0.3
            return (float(np.clip(fx, 0, 1)), float(np.clip(fy, 0, 1)), 1.0, 1.0)

        elif scene_type == "multi_face" and faces:
            x_min = min(f.bbox[0] for f in faces)
            y_min = min(f.bbox[1] for f in faces)
            x_max = max(f.bbox[0] + f.bbox[2] for f in faces)
            y_max = max(f.bbox[1] + f.bbox[3] for f in faces)
            cx = (x_min + x_max) / 2
            cy = (y_min + y_max) / 2
            w = min(1.0, (x_max - x_min) * 1.2)
            h = min(1.0, (y_max - y_min) * 1.2)
            return (float(cx), float(cy), float(w), float(h))

        elif scene_type == "motion":
            if sal_center:
                return (sal_center[0], sal_center[1], 1.0, 1.0)
            return (0.5, 0.5, 1.0, 1.0)

        else:
            if sal_center:
                return (sal_center[0], sal_center[1], 1.0, 1.0)
            return (0.5, 0.5, 1.0, 1.0)

    def reset(self):
        """重置状态（新视频时调用）"""
        self._prev_gray = None
        self._scene_history.clear()
        self._current_stable_scene = "static"
        self._sal_ema_x = 0.5
        self._sal_ema_y = 0.5
        self._sal_initialized = False
