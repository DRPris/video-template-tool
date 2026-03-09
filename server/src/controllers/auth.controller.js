import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import db from '../config/database.js';

// Seed default admin user if no users exist
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run('admin', hash, '管理员', 'admin');
    console.log('✅ 默认管理员账号已创建: admin / admin123');
}

export function login(req, res) {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: '请输入用户名和密码' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = jwt.sign({ userId: user.id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

    res.json({
        token,
        user: {
            id: user.id,
            username: user.username,
            displayName: user.display_name,
            role: user.role,
        },
    });
}

export function getMe(req, res) {
    res.json({
        user: {
            id: req.user.id,
            username: req.user.username,
            displayName: req.user.display_name,
            role: req.user.role,
        },
    });
}

export function register(req, res) {
    const { username, password, displayName } = req.body;
    if (!username || !password || !displayName) {
        return res.status(400).json({ error: '请填写所有必填字段' });
    }

    if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: '用户名长度需要在3-20个字符之间' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: '密码至少需要6个字符' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
        return res.status(409).json({ error: '用户名已存在' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)').run(username, hash, displayName, 'user');

    const token = jwt.sign({ userId: result.lastInsertRowid }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

    res.status(201).json({
        token,
        user: {
            id: result.lastInsertRowid,
            username,
            displayName,
            role: 'user',
        },
    });
}

export function listUsers(req, res) {
    const users = db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at DESC').all();
    res.json({ users });
}
