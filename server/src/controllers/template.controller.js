import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import db from '../config/database.js';
import config from '../config/index.js';

// Template dimensions by type
const TEMPLATE_DIMENSIONS = {
    '1:1': { width: 1080, height: 1080 },
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
};

/**
 * Read image dimensions via ffprobe.
 * @param {string} imagePath
 * @returns {{width:number,height:number}|null}
 */
function readImageDimensions(imagePath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=s=x:p=0',
        imagePath,
    ], { encoding: 'utf-8' });

    if (probe.status !== 0 || !probe.stdout) {
        return null;
    }

    const [widthStr, heightStr] = probe.stdout.trim().split('x');
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }

    return { width, height };
}

export function listTemplates(req, res) {
    const { type } = req.query;
    let templates;
    if (type) {
        templates = db.prepare('SELECT * FROM templates WHERE type = ? ORDER BY created_at DESC').all(type);
    } else {
        templates = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all();
    }
    res.json({ templates });
}

export function getTemplate(req, res) {
    const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!template) {
        return res.status(404).json({ error: '模板不存在' });
    }
    res.json({ template });
}

export function createTemplate(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: '请上传模板图片 (PNG格式)' });
    }

    const { name, type, videoAreaX, videoAreaY, videoAreaWidth, videoAreaHeight } = req.body;

    if (!name || !type) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: '请填写模板名称和类型' });
    }

    if (!TEMPLATE_DIMENSIONS[type]) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: '模板类型无效，支持: 1:1, 16:9, 9:16' });
    }

    const dims = TEMPLATE_DIMENSIONS[type];
    const actualDims = readImageDimensions(req.file.path);
    if (!actualDims) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: '无法读取模板图片尺寸，请检查文件是否损坏' });
    }

    if (actualDims.width !== dims.width || actualDims.height !== dims.height) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
            error: `模板尺寸不匹配：${type} 需要 ${dims.width}x${dims.height}，当前为 ${actualDims.width}x${actualDims.height}`,
        });
    }

    const vaX = parseInt(videoAreaX) || 0;
    const vaY = parseInt(videoAreaY) || 0;
    const vaW = parseInt(videoAreaWidth) || (type === '1:1' ? 540 : type === '16:9' ? 608 : dims.width);
    const vaH = parseInt(videoAreaHeight) || (type === '9:16' ? dims.height : 960);

    const relativePath = path.relative(config.upload.dir, req.file.path);

    try {
        const result = db.prepare(`
      INSERT INTO templates (name, type, file_path, width, height, video_area_x, video_area_y, video_area_width, video_area_height, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, type, relativePath, dims.width, dims.height, vaX, vaY, vaW, vaH, req.user.id);

        const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json({ template });
    } catch (err) {
        fs.unlinkSync(req.file.path);
        res.status(500).json({ error: '创建模板失败: ' + err.message });
    }
}

export function updateTemplate(req, res) {
    const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!template) {
        return res.status(404).json({ error: '模板不存在' });
    }

    const { name, videoAreaX, videoAreaY, videoAreaWidth, videoAreaHeight } = req.body;

    db.prepare(`
    UPDATE templates SET
      name = COALESCE(?, name),
      video_area_x = COALESCE(?, video_area_x),
      video_area_y = COALESCE(?, video_area_y),
      video_area_width = COALESCE(?, video_area_width),
      video_area_height = COALESCE(?, video_area_height)
    WHERE id = ?
  `).run(
        name || null,
        videoAreaX != null ? parseInt(videoAreaX) : null,
        videoAreaY != null ? parseInt(videoAreaY) : null,
        videoAreaWidth != null ? parseInt(videoAreaWidth) : null,
        videoAreaHeight != null ? parseInt(videoAreaHeight) : null,
        req.params.id
    );

    const updated = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    res.json({ template: updated });
}

export function deleteTemplate(req, res) {
    const template = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!template) {
        return res.status(404).json({ error: '模板不存在' });
    }

    // Check if template is used in active tasks
    const activeTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE template_id = ? AND status IN ('queued', 'processing')").get(req.params.id);
    if (activeTasks.count > 0) {
        return res.status(400).json({ error: '该模板正在被使用，无法删除' });
    }

    // Delete template file
    const fullPath = path.join(config.upload.dir, template.file_path);
    if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
    }

    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
    res.json({ message: '模板已删除' });
}
