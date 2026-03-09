import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, '../../data/database.sqlite');

// Ensure data directory exists
import fs from 'fs';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('1:1', '16:9', '9:16')),
    file_path TEXT NOT NULL,
    thumbnail_path TEXT,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    video_area_x INTEGER NOT NULL DEFAULT 0,
    video_area_y INTEGER NOT NULL DEFAULT 0,
    video_area_width INTEGER NOT NULL,
    video_area_height INTEGER NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    template_id INTEGER NOT NULL,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    total_videos INTEGER NOT NULL DEFAULT 0,
    completed_videos INTEGER NOT NULL DEFAULT 0,
    failed_videos INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (template_id) REFERENCES templates(id)
  );

  CREATE TABLE IF NOT EXISTS task_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    video_id TEXT UNIQUE NOT NULL,
    original_filename TEXT NOT NULL,
    input_path TEXT NOT NULL,
    output_path TEXT,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed', 'failed')),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    progress_percent INTEGER DEFAULT 0,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_task_videos_task_id ON task_videos(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_videos_status ON task_videos(status);
`);

export default db;
