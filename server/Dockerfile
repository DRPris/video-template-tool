FROM node:22-slim

# Use Aliyun mirror for apt (China)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources

# Install FFmpeg + build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Use China npm mirror
RUN npm config set registry https://registry.npmmirror.com

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Remove build tools to reduce image size
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY src/ ./src/

# Create upload directories
RUN mkdir -p uploads/videos uploads/templates uploads/outputs data

EXPOSE 3000

CMD ["node", "src/server.js"]
