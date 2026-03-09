# 视频套模板工具

将 9:16 竖版短视频通过图片模板快速转换为不同尺寸的视频，支持批量处理、多用户在线使用。

## 功能特性

- 🎬 **三种模板类型**：1:1 正方形 / 16:9 横版 / 9:16 覆盖
- �️ **无黑边合成**：视频铺满模板区域，自动裁切，杜绝黑边
- �📦 **批量处理**：单次最多 20 条视频排队处理
- 👥 **多用户支持**：JWT 认证，用户隔离
- 📡 **实时进度**：WebSocket 推送处理进度
- 🔄 **失败重试**：自动重试（2 次） + 手动重试
- 📥 **批量下载**：单个下载 / ZIP 打包下载
- �️ **尺寸校验**：上传时 + 处理时双重校验模板尺寸，拒绝脏数据
- �🐳 **Docker 部署**：一键部署到服务器

## 视频合成 — 无黑边处理机制

所有模板类型均采用 **Cover 模式**（等比放大 + 居中裁切），确保视频铺满目标区域、完全无黑边。

### 9:16 竖版模板

视频经过 SAR 归一化后，使用 `force_original_aspect_ratio=increase` 放大至覆盖整个 1080×1920 画布，再用 `crop` 居中裁切到目标尺寸，模板 PNG 直接叠加在上层。

### 1:1 / 16:9 模板

采用 **双层合成** 策略：

1. **模糊背景层**：源视频放大裁切铺满整个画布，叠加 `boxblur` 模糊效果作为底层背景
2. **清晰视频层**：源视频在指定的 `videoArea` 区域内同样使用 Cover 模式铺满
3. **模板叠加层**：PNG 模板（含透明通道）覆盖在最上层

即使视频比例与模板区域不完全匹配，模糊背景也会填充所有间隙，确保无黑边。

### 防御性措施

| 措施 | 说明 |
|------|------|
| SAR 归一化 | `scale=iw*sar:ih,setsar=1` 处理手机录制视频的非方形像素 |
| 模板尺寸归一化 | `normalizeTemplateGeometry()` 强制使用标准尺寸，屏蔽历史脏数据 |
| 上传时校验 | 通过 ffprobe 读取图片实际尺寸，不匹配则拒绝上传 |
| 处理时校验 | 运行前再次验证模板图片尺寸与类型是否一致 |
| 显式 DAR/SAR | `setsar=1,setdar=W/H` 防止播放器误判纵横比 |
| H.264 方向修正 | `h264_metadata=display_orientation=remove` 删除旋转元数据 |

## 快速开始（本地开发）

### 前置条件

- Node.js 18+
- Redis
- FFmpeg

### 1. 安装依赖

```bash
# 后端
cd server && npm install

# 前端
cd client && npm install
```

### 2. 启动 Redis

```bash
brew services start redis   # macOS
# 或
redis-server                 # 手动启动
```

### 3. 启动服务

```bash
# 启动后端 API + Worker
cd server && npm run dev

# 启动前端（新终端）
cd client && npm run dev
```

### 4. 访问

- 前端：http://localhost:5173
- API：http://localhost:3000
- 默认管理员：`admin` / `admin123`

## Docker 部署（生产环境）

```bash
# 修改 JWT 密钥
export JWT_SECRET="your-secure-secret-key"

# 构建并启动
docker compose up -d --build

# 访问
# http://your-server-ip
```

## 模板制作规范

| 类型 | 尺寸 | 格式 | 说明 |
|------|------|------|------|
| 1:1 | 1080×1080 px | PNG (含透明通道) | 视频区域使用透明像素 |
| 16:9 | 1920×1080 px | PNG (含透明通道) | 中间透明，两侧放信息 |
| 9:16 | 1080×1920 px | PNG (含透明通道) | 信息层覆盖在视频上 |

> 透明区域 = 视频显示区域，不透明区域 = 品牌信息/装饰

## 项目结构

```
├── client/                  # 前端 (React + Vite)
│   └── src/
│       ├── pages/           # 页面组件
│       ├── services/        # API 和 Socket 通信
│       └── App.jsx          # 主应用入口
├── server/                  # 后端 (Node.js + Express)
│   └── src/
│       ├── controllers/     # 路由处理
│       ├── services/        # 核心服务
│       │   ├── ffmpeg.service.js   # 视频合成（无黑边处理）
│       │   └── queue.service.js    # BullMQ 任务队列
│       ├── config/          # 配置 & 数据库
│       ├── middleware/      # JWT 认证中间件
│       └── routes/          # API 路由定义
├── nginx/                   # Nginx 反向代理配置
├── docker-compose.yml       # Docker 编排
└── deploy.sh                # 部署脚本
```

## 技术栈

- **前端**：React + Vite
- **后端**：Node.js + Express
- **队列**：BullMQ + Redis
- **视频处理**：FFmpeg（libx264 编码，Cover 模式无黑边合成）
- **数据库**：SQLite (MVP) / PostgreSQL (生产)
- **实时通信**：Socket.IO
- **部署**：Docker Compose + Nginx
