"""
平滑算法模块 - 四层平滑管线

Layer 1: 卡尔曼滤波 — 追踪阶段抗抖动（加强版，前向+后向双向平滑）
Layer 2: 死区过滤 — 小幅位移直接忽略
Layer 3: 三次贝塞尔 — 关键帧之间自然过渡
Layer 4: 速度约束 — 全局兜底防跳变 + EMA 额外平滑
"""
import numpy as np
from typing import List, Tuple, Optional
from filterpy.kalman import KalmanFilter
from scipy.interpolate import CubicSpline
import config


class KalmanSmoother:
    """卡尔曼滤波平滑器 - 追踪阶段逐帧抗抖动"""

    def __init__(self):
        # 状态: [x, y, vx, vy]  观测: [x, y]
        self.kf = KalmanFilter(dim_x=4, dim_z=2)

        # 状态转移矩阵 (匀速模型)
        self.kf.F = np.array([
            [1, 0, 1, 0],
            [0, 1, 0, 1],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ], dtype=float)

        # 观测矩阵
        self.kf.H = np.array([
            [1, 0, 0, 0],
            [0, 1, 0, 0],
        ], dtype=float)

        # 过程噪声 — 越小越平滑（更信任匀速模型）
        q = config.KALMAN_PROCESS_NOISE
        self.kf.Q = np.eye(4) * q
        self.kf.Q[2, 2] = q * 0.5  # 速度方差更小 → 速度更稳定
        self.kf.Q[3, 3] = q * 0.5

        # 观测噪声 — 越大越平滑（更不信任检测值）
        r = config.KALMAN_MEASUREMENT_NOISE
        self.kf.R = np.eye(2) * r

        # 初始协方差
        self.kf.P *= 10.0

        self._initialized = False

    def update(self, x: float, y: float) -> Tuple[float, float]:
        """输入观测 (x, y)，返回平滑后的 (x, y)"""
        z = np.array([x, y])

        if not self._initialized:
            self.kf.x = np.array([x, y, 0, 0], dtype=float)
            self._initialized = True
            return (x, y)

        self.kf.predict()
        self.kf.update(z)

        sx = float(self.kf.x[0])
        sy = float(self.kf.x[1])
        return (sx, sy)

    def reset(self):
        self._initialized = False
        self.kf.P = np.eye(4) * 10.0


def forward_backward_kalman(
    points: List[Tuple[float, float]],
) -> List[Tuple[float, float]]:
    """
    双向卡尔曼滤波: 前向 + 后向各跑一遍，取平均值。
    消除单向卡尔曼的滞后问题，同时获得更好的平滑效果。
    """
    if len(points) <= 2:
        return list(points)

    # 前向
    fwd = KalmanSmoother()
    fwd_result = []
    for x, y in points:
        sx, sy = fwd.update(x, y)
        fwd_result.append((sx, sy))

    # 后向
    bwd = KalmanSmoother()
    bwd_result = []
    for x, y in reversed(points):
        sx, sy = bwd.update(x, y)
        bwd_result.append((sx, sy))
    bwd_result.reverse()

    # 取平均
    result = []
    for (fx, fy), (bx, by) in zip(fwd_result, bwd_result):
        result.append(((fx + bx) / 2, (fy + by) / 2))

    return result


def deadzone_filter(
    points: List[Tuple[float, float]],
    threshold: float = config.DEADZONE_THRESHOLD,
) -> List[Tuple[float, float]]:
    """
    死区过滤: 当位移小于阈值时，保持上一帧的位置不动。
    消除"静止时画面微抖"的问题。
    """
    if len(points) <= 1:
        return list(points)

    result = [points[0]]
    for i in range(1, len(points)):
        px, py = result[-1]
        cx, cy = points[i]
        dist = np.sqrt((cx - px) ** 2 + (cy - py) ** 2)

        if dist < threshold:
            # 位移太小，保持不动
            result.append((px, py))
        else:
            result.append((cx, cy))

    return result


def velocity_clamp(
    points: List[Tuple[float, float]],
    max_v: float = config.MAX_VELOCITY_PX_PER_FRAME,
    frame_w: int = 1920,
    frame_h: int = 1080,
) -> List[Tuple[float, float]]:
    """
    速度约束：限制相邻帧之间的最大位移

    points: 归一化坐标列表 [(x, y), ...]
    max_v: 最大像素速度/帧
    """
    if len(points) <= 1:
        return points

    max_dx = max_v / frame_w
    max_dy = max_v / frame_h

    result = [points[0]]
    for i in range(1, len(points)):
        px, py = result[-1]
        cx, cy = points[i]

        dx = np.clip(cx - px, -max_dx, max_dx)
        dy = np.clip(cy - py, -max_dy, max_dy)

        result.append((px + dx, py + dy))

    return result


def ema_smooth(
    points: List[Tuple[float, float]],
    alpha: float = config.EMA_ALPHA,
) -> List[Tuple[float, float]]:
    """
    指数移动平均 (EMA) 平滑。
    alpha 越小越平滑 (0.08 = 非常平滑)。
    双向 EMA 以消除滞后。
    """
    if len(points) <= 2:
        return list(points)

    # 前向 EMA
    fwd = [points[0]]
    for i in range(1, len(points)):
        px, py = fwd[-1]
        cx, cy = points[i]
        fwd.append((alpha * cx + (1 - alpha) * px,
                     alpha * cy + (1 - alpha) * py))

    # 后向 EMA
    bwd = [points[-1]]
    for i in range(len(points) - 2, -1, -1):
        px, py = bwd[-1]
        cx, cy = points[i]
        bwd.append((alpha * cx + (1 - alpha) * px,
                     alpha * cy + (1 - alpha) * py))
    bwd.reverse()

    # 取平均消除滞后
    result = []
    for (fx, fy), (bx, by) in zip(fwd, bwd):
        result.append(((fx + bx) / 2, (fy + by) / 2))

    return result


def bezier_interpolate(
    keyframes: List[Tuple[int, float, float]],
    total_frames: int,
) -> List[Tuple[float, float]]:
    """
    三次贝塞尔插值 — 关键帧之间平滑过渡

    keyframes: [(frame_idx, x, y), ...] 归一化坐标
    total_frames: 总帧数
    返回: 每一帧的 (x, y) 列表
    """
    if not keyframes:
        return [(0.5, 0.5)] * total_frames

    if len(keyframes) == 1:
        return [(keyframes[0][1], keyframes[0][2])] * total_frames

    # 排序
    keyframes = sorted(keyframes, key=lambda k: k[0])

    # 提取坐标
    indices = [k[0] for k in keyframes]
    xs = [k[1] for k in keyframes]
    ys = [k[2] for k in keyframes]

    # 确保首尾帧存在
    if indices[0] > 0:
        indices.insert(0, 0)
        xs.insert(0, xs[0])
        ys.insert(0, ys[0])
    if indices[-1] < total_frames - 1:
        indices.append(total_frames - 1)
        xs.append(xs[-1])
        ys.append(ys[-1])

    # 三次样条插值
    if len(indices) >= 4:
        spline_x = CubicSpline(indices, xs, bc_type='clamped')
        spline_y = CubicSpline(indices, ys, bc_type='clamped')
    else:
        # 不够 4 个点时使用 natural 边界
        spline_x = CubicSpline(indices, xs, bc_type='natural')
        spline_y = CubicSpline(indices, ys, bc_type='natural')

    all_frames = np.arange(total_frames)
    interp_x = np.clip(spline_x(all_frames), 0, 1)
    interp_y = np.clip(spline_y(all_frames), 0, 1)

    return list(zip(interp_x.tolist(), interp_y.tolist()))


def smooth_pipeline(
    raw_points: List[Tuple[float, float]],
    keyframes: Optional[List[Tuple[int, float, float]]] = None,
    frame_w: int = 1920,
    frame_h: int = 1080,
) -> List[Tuple[float, float]]:
    """
    四层平滑管线

    raw_points: 每帧的原始 ROI 中心 [(x, y), ...]
    keyframes:  用户标注的关键帧 [(frame_idx, x, y), ...] 可选
    返回: 平滑后的每帧 ROI 中心
    """
    total = len(raw_points)
    if total == 0:
        return []

    # Layer 1: 双向卡尔曼滤波（消除抖动 + 消除滞后）
    kalman_smoothed = forward_backward_kalman(raw_points)

    # Layer 2: 死区过滤（静止时保持不动）
    deadzone_result = deadzone_filter(kalman_smoothed)

    # Layer 3: 贝塞尔插值（如果有关键帧，则用关键帧覆盖）
    if keyframes and len(keyframes) >= 2:
        bezier_result = bezier_interpolate(keyframes, total)
        # 混合：关键帧附近权重偏向用户标注，其余偏向卡尔曼
        kf_indices = set(k[0] for k in keyframes)
        blended = []
        for i in range(total):
            # 计算距离最近关键帧的距离
            min_dist = min(abs(i - ki) for ki in kf_indices) if kf_indices else total
            # 距离越近，贝塞尔权重越大
            blend = max(0, 1.0 - min_dist / 30.0)  # 30 帧内渐变
            bx, by = bezier_result[i]
            kx, ky = deadzone_result[i]
            x = bx * blend + kx * (1 - blend)
            y = by * blend + ky * (1 - blend)
            blended.append((x, y))
        deadzone_result = blended

    # Layer 4: 速度约束 + EMA 额外平滑
    velocity_clamped = velocity_clamp(deadzone_result, frame_w=frame_w, frame_h=frame_h)
    result = ema_smooth(velocity_clamped)

    return result
