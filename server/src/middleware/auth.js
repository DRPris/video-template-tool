import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import db from '../config/database.js';

export function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未登录，请先登录' });
    }

    const token = authHeader.split(' ')[1];
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
