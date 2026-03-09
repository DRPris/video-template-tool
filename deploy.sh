#!/bin/bash
# ============================================
# 视频套模板工具 - 服务器一键部署脚本
# 在阿里云服务器上运行此脚本
# ============================================

set -e

echo "🎬 视频套模板工具 - 部署开始"
echo "==============================="

# 1. Check Docker
echo "📋 检查 Docker..."
if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装，请选择 Docker 应用镜像"
    exit 1
fi
docker --version
docker compose version 2>/dev/null || { echo "安装 docker compose 插件..."; apt-get update && apt-get install -y docker-compose-plugin; }

# 2. Create swap if memory < 4GB (helps prevent OOM)
TOTAL_MEM=$(free -m | awk '/^Mem:/ {print $2}')
if [ "$TOTAL_MEM" -lt 4000 ]; then
    echo "⚠️  内存 ${TOTAL_MEM}MB < 4GB，创建 2GB Swap..."
    if [ ! -f /swapfile ]; then
        fallocate -l 2G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
        echo "✅ 2GB Swap 已创建"
    else
        echo "✅ Swap 已存在"
    fi
fi

# 3. Generate JWT secret
JWT_SECRET=$(openssl rand -hex 32)
echo "🔐 JWT 密钥已生成"

# 4. Create .env file
cat > .env << EOF
JWT_SECRET=${JWT_SECRET}
FFMPEG_CONCURRENCY=1
EOF
echo "✅ .env 配置已创建"

# 5. Build and start
echo "🔨 构建 Docker 镜像（首次可能需要 5-10 分钟）..."
docker compose build --no-cache

echo "🚀 启动服务..."
docker compose up -d

# 6. Wait for services to be ready
echo "⏳ 等待服务启动..."
sleep 10

# 7. Health check
if curl -sf http://localhost/api/health > /dev/null 2>&1; then
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║  ✅ 部署成功！                             ║"
    echo "║                                          ║"
    echo "║  访问地址: http://$(curl -s ifconfig.me)   "
    echo "║  默认账号: admin / admin123               ║"
    echo "║                                          ║"
    echo "║  ⚠️  请立即修改默认密码！                  ║"
    echo "╚══════════════════════════════════════════╝"
else
    echo "⚠️  服务可能还在启动中，请稍等后访问"
    echo "   检查状态: docker compose logs -f"
fi

echo ""
echo "常用命令:"
echo "  查看日志:   docker compose logs -f"
echo "  重启服务:   docker compose restart"
echo "  停止服务:   docker compose down"
echo "  查看状态:   docker compose ps"
