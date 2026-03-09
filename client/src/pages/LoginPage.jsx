import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useToast } from '../App';
import { authAPI } from '../services/api';

export default function LoginPage() {
    const [isRegister, setIsRegister] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const { user, login } = useAuth();
    const navigate = useNavigate();
    const toast = useToast();

    // Redirect if already logged in
    if (user) {
        navigate('/workspace', { replace: true });
        return null;
    }

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            let res;
            if (isRegister) {
                res = await authAPI.register(username, password, displayName);
            } else {
                res = await authAPI.login(username, password);
            }

            login(res.data.token, res.data.user);
            toast('登录成功！', 'success');
            navigate('/workspace', { replace: true });
        } catch (err) {
            setError(err.response?.data?.error || '操作失败，请重试');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card animate-fade-in">
                <div className="login-title">🎬 视频模板工具</div>
                <div className="login-subtitle">
                    {isRegister ? '创建新账号' : '登录以开始使用'}
                </div>

                <form className="login-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">用户名</label>
                        <input
                            className="form-input"
                            type="text"
                            placeholder="请输入用户名"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                            autoFocus
                        />
                    </div>

                    {isRegister && (
                        <div className="form-group">
                            <label className="form-label">显示名称</label>
                            <input
                                className="form-input"
                                type="text"
                                placeholder="你希望别人怎么称呼你"
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                required
                            />
                        </div>
                    )}

                    <div className="form-group">
                        <label className="form-label">密码</label>
                        <input
                            className="form-input"
                            type="password"
                            placeholder="请输入密码"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>

                    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

                    <button className="btn btn-primary btn-lg" type="submit" disabled={loading}>
                        {loading ? '处理中...' : isRegister ? '注册' : '登录'}
                    </button>
                </form>

                <div style={{ textAlign: 'center', marginTop: 20 }}>
                    <button
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text-link)',
                            cursor: 'pointer',
                            fontSize: 14,
                            fontFamily: 'var(--font-family)',
                        }}
                        onClick={() => {
                            setIsRegister(!isRegister);
                            setError('');
                        }}
                    >
                        {isRegister ? '已有账号？去登录' : '没有账号？注册'}
                    </button>
                </div>

                {!isRegister && (
                    <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: 'var(--color-text-muted)' }}>
                        默认管理员账号: admin / admin123
                    </div>
                )}
            </div>
        </div>
    );
}
