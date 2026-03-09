import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',

  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '524288000', 10), // 500MB
    dir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || './uploads'),
    videosDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || './uploads', 'videos'),
    templatesDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || './uploads', 'templates'),
    outputsDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || './uploads', 'outputs'),
  },

  ffmpeg: {
    concurrency: parseInt(process.env.FFMPEG_CONCURRENCY || '2', 10),
    timeout: parseInt(process.env.FFMPEG_TIMEOUT || '600000', 10), // 10 min
  },

  fileRetentionDays: parseInt(process.env.FILE_RETENTION_DAYS || '7', 10),
};
