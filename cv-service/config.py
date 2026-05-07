"""
CV 智能裁切微服务 - 配置
"""
import os

# Redis
REDIS_HOST = os.getenv("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

# 视频分析
MAX_ANALYSIS_FPS = int(os.getenv("MAX_ANALYSIS_FPS", "5"))  # 每秒分析帧数
FACE_DETECTION_CONFIDENCE = float(os.getenv("FACE_CONFIDENCE", "0.5"))
FACE_TRACKING_CONFIDENCE = float(os.getenv("FACE_TRACKING_CONFIDENCE", "0.5"))

# 场景分类阈值
SCENE_SINGLE_FACE_THRESHOLD = 1       # 1 张人脸 → 单人出镜
SCENE_MULTI_FACE_THRESHOLD = 2        # ≥2 张人脸 → 多人对话
MOTION_THRESHOLD = 30.0               # 光流大小 → 运动场景

# ---------- 平滑参数（核心抗抖调参）----------
# 卡尔曼滤波
# 过程噪声越小 → 越信任预测(即速度模型)，越平滑
# 观测噪声越大 → 越不信任检测值，越平滑
KALMAN_PROCESS_NOISE = float(os.getenv("KALMAN_PROCESS_NOISE", "0.0005"))
KALMAN_MEASUREMENT_NOISE = float(os.getenv("KALMAN_MEASUREMENT_NOISE", "0.8"))

# 速度约束 (像素/帧)
# 1920px 画面下: 5px/帧 × 30fps = 150px/s ≈ 画面 7.8% 每秒，已经是比较快的平移
MAX_VELOCITY_PX_PER_FRAME = float(os.getenv("MAX_VELOCITY", "5.0"))

# 贝塞尔张力
BEZIER_TENSION = float(os.getenv("BEZIER_TENSION", "0.4"))

# ---------- 抗抖动扩展参数 ----------
# 死区阈值: ROI 中心位移小于此值(归一化)时，视为"静止"不做调整
# 0.02 ≈ 1920px 下 38px，避免画面微抖
DEADZONE_THRESHOLD = float(os.getenv("DEADZONE_THRESHOLD", "0.02"))

# 场景类型稳定窗口（帧数）：连续 N 帧出现同一场景才切换
SCENE_STABLE_WINDOW = int(os.getenv("SCENE_STABLE_WINDOW", "10"))

# 移动平均窗口大小（帧数），对卡尔曼输出做额外 EMA 平滑
EMA_ALPHA = float(os.getenv("EMA_ALPHA", "0.08"))  # 越小越平滑

# 上传路径 (与 Node.js 共享)
UPLOAD_DIR = os.getenv("UPLOAD_DIR", os.path.join(os.path.dirname(__file__), "..", "server", "uploads"))
