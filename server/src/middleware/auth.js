import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import db from '../config/database.js';

export function authenticate(req, res, next) {
    // 优先从 Authorization 头取 token，其次从 URL 查询参数取（用于文件下载等场景）
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: '未登录，请先登录' });
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(decoded.userId);
        if (!user) {
            return res.status(401).json({ error: '用户不存在' });
        }
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token 无效或已过期' });
    }
}

export function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
}
