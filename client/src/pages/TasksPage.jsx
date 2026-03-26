import { useState, useEffect, useCallback } from 'react';
import { taskAPI } from '../services/api';
import { getSocket, connectSocket } from '../services/socket';
import { useToast } from '../App';
import dayjs from 'dayjs';

const API_BASE = import.meta.env.VITE_API_URL || '';

const STATUS_MAP = {
    queued: { label: '排队中', class: 'badge-queued', icon: '⏳' },
    processing: { label: '处理中', class: 'badge-processing', icon: '⚙️' },
    completed: { label: '已完成', class: 'badge-completed', icon: '✅' },
    failed: { label: '失败', class: 'badge-failed', icon: '❌' },
    cancelled: { label: '已取消', class: 'badge-failed', icon: '🚫' },
};

export default function TasksPage() {
    const [tasks, setTasks] = useState([]);
    const [expandedTask, setExpandedTask] = useState(null);
    const [taskDetail, setTaskDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const toast = useToast();

    const loadTasks = useCallback(async () => {
        try {
            const res = await taskAPI.list();
            setTasks(res.data.tasks);
        } catch (err) {
            toast('加载任务列表失败', 'error');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        loadTasks();
        const interval = setInterval(loadTasks, 10000); // Refresh every 10s

        // Listen for WebSocket progress updates
        const socket = getSocket() || connectSocket();
        if (socket) {
            socket.on('task:progress', (data) => {
                setTasks((prev) =>
                    prev.map((t) => {
                        if (t.task_id === data.taskId) {
                            const updates = {};
                            if (data.status === 'completed' && !data.videoId) {
                                updates.status = 'completed';
                                updates.completed_videos = data.completedVideos;
                                updates.failed_videos = data.failedVideos;
                            }
                            if (data.status === 'failed' && !data.videoId) {
                                updates.status = 'failed';
                            }
                            if (data.completedVideos !== undefined) {
                                updates.completed_videos = data.completedVideos;
                            }
                            if (data.failedVideos !== undefined) {
                                updates.failed_videos = data.failedVideos;
                            }
                            if (data.status === 'processing' && t.status === 'queued') {
                                updates.status = 'processing';
                            }
                            return { ...t, ...updates };
                        }
                        return t;
                    })
                );

                // Update expanded task detail
                if (taskDetail && data.taskId === taskDetail.task?.task_id && data.videoId) {
                    setTaskDetail((prev) => {
                        if (!prev) return prev;
                        return {
                            ...prev,
                            videos: prev.videos.map((v) =>
                                v.video_id === data.videoId
                                    ? { ...v, status: data.status, progress_percent: data.progress || v.progress_percent }
                                    : v
                            ),
                        };
                    });
                }
            });
        }

        return () => {
            clearInterval(interval);
            if (socket) {
                socket.off('task:progress');
            }
        };
    }, [loadTasks, taskDetail]);

    const loadTaskDetail = async (taskId) => {
        if (expandedTask === taskId) {
            setExpandedTask(null);
            setTaskDetail(null);
            return;
        }

        try {
            const res = await taskAPI.get(taskId);
            setTaskDetail(res.data);
            setExpandedTask(taskId);
        } catch (err) {
            toast('加载任务详情失败', 'error');
        }
    };

    const handleRetry = async (taskId) => {
        try {
            await taskAPI.retry(taskId);
            toast('已重新提交失败的视频', 'success');
            loadTasks();
            if (expandedTask === taskId) {
                const res = await taskAPI.get(taskId);
                setTaskDetail(res.data);
            }
        } catch (err) {
            toast(err.response?.data?.error || '重试失败', 'error');
        }
    };

    const handleDelete = async (taskId) => {
        if (!confirm('确定要删除这个任务吗？所有相关文件都会被删除。')) return;
        try {
            await taskAPI.delete(taskId);
            toast('任务已删除', 'success');
            setTasks((prev) => prev.filter((t) => t.task_id !== taskId));
            if (expandedTask === taskId) {
                setExpandedTask(null);
                setTaskDetail(null);
            }
        } catch (err) {
            toast(err.response?.data?.error || '删除失败', 'error');
        }
    };

    const handleDownload = async (taskId, videoId) => {
        const token = localStorage.getItem('token');
        if (!token) { toast('请先登录', 'error'); return; }
        const url = `${taskAPI.downloadUrl(taskId, videoId)}?token=${encodeURIComponent(token)}`;
        // 先用 HEAD 请求检查文件是否可下载，避免失败时浏览器跳转到错误 JSON 页面
        try {
            const check = await fetch(url, { method: 'HEAD' });
            if (!check.ok) {
                toast(check.status === 401 ? '登录已过期，请重新登录' :
                      check.status === 404 ? '文件不存在或已过期' : '下载失败', 'error');
                return;
            }
        } catch {
            toast('网络连接失败，请检查服务器是否正常', 'error');
            return;
        }
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const handleDownloadAll = (taskId) => {
        const token = localStorage.getItem('token');
        if (!token) { toast('请先登录', 'error'); return; }
        const url = `${taskAPI.downloadAllUrl(taskId)}?token=${encodeURIComponent(token)}`;
        toast('正在打包下载，请稍候...', 'info');
        // 用浏览器原生下载（流式传输），避免大 zip 占满内存
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const getOverallProgress = (task) => {
        if (task.total_videos === 0) return 0;
        return Math.round(((task.completed_videos + task.failed_videos) / task.total_videos) * 100);
    };

    if (loading) {
        return (
            <div className="page-container">
                <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-secondary)' }}>
                    加载中...
                </div>
            </div>
        );
    }

    return (
        <div className="page-container animate-fade-in">
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <h1 className="page-title">任务中心</h1>
                    <p className="page-subtitle">查看和管理视频处理任务</p>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={loadTasks}>🔄 刷新</button>
            </div>

            {tasks.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-icon">📋</div>
                    <div className="empty-title">暂无任务</div>
                    <div className="empty-desc">去工作台提交视频处理任务吧</div>
                </div>
            ) : (
                <div className="task-list">
                    {tasks.map((task) => {
                        const status = STATUS_MAP[task.status] || STATUS_MAP.queued;
                        const isExpanded = expandedTask === task.task_id;
                        const progress = getOverallProgress(task);

                        return (
                            <div key={task.task_id} className="task-card">
                                <div className="task-header">
                                    <div
                                        className="task-title"
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => loadTaskDetail(task.task_id)}
                                    >
                                        {status.icon} {task.template_name || '未知模板'}
                                        <span style={{ color: 'var(--color-text-muted)', fontSize: 13, marginLeft: 8 }}>
                                            ({task.template_type})
                                        </span>
                                    </div>
                                    <span className={`badge ${status.class}`}>{status.label}</span>
                                </div>

                                <div className="task-meta">
                                    <span>📹 {task.total_videos} 个视频</span>
                                    <span>✅ {task.completed_videos} 完成</span>
                                    {task.failed_videos > 0 && <span style={{ color: 'var(--color-accent-red)' }}>❌ {task.failed_videos} 失败</span>}
                                    <span>🕐 {dayjs(task.created_at).format('MM-DD HH:mm')}</span>
                                </div>

                                {(task.status === 'processing' || task.status === 'queued') && (
                                    <div className="progress-bar" style={{ marginBottom: 8 }}>
                                        <div className="progress-fill" style={{ width: `${progress}%` }}></div>
                                    </div>
                                )}

                                <div className="task-actions">
                                    <button className="btn btn-secondary btn-sm" onClick={() => loadTaskDetail(task.task_id)}>
                                        {isExpanded ? '收起详情' : '查看详情'}
                                    </button>
                                    {task.completed_videos > 0 && (
                                        <button className="btn btn-primary btn-sm" onClick={() => handleDownloadAll(task.task_id)}>
                                            📦 打包下载已完成 ({task.completed_videos})
                                        </button>
                                    )}
                                    {task.failed_videos > 0 && (
                                        <button className="btn btn-secondary btn-sm" onClick={() => handleRetry(task.task_id)}>
                                            🔄 重试失败
                                        </button>
                                    )}
                                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(task.task_id)}>
                                        🗑 删除
                                    </button>
                                </div>

                                {/* Expanded Detail */}
                                {isExpanded && taskDetail && (
                                    <div className="task-video-list">
                                        {taskDetail.videos.map((video) => {
                                            const vStatus = STATUS_MAP[video.status] || STATUS_MAP.queued;
                                            return (
                                                <div key={video.video_id} className="task-video-item">
                                                    <span>{vStatus.icon}</span>
                                                    <span className="video-name">{video.original_filename}</span>
                                                    {video.status === 'processing' && (
                                                        <div className="video-progress">
                                                            <div className="progress-bar">
                                                                <div className="progress-fill" style={{ width: `${video.progress_percent}%` }}></div>
                                                            </div>
                                                        </div>
                                                    )}
                                                    <span className={`badge ${vStatus.class}`} style={{ fontSize: 11 }}>
                                                        {video.status === 'processing' ? `${video.progress_percent}%` : vStatus.label}
                                                    </span>
                                                    {video.status === 'completed' && (
                                                        <button
                                                            className="btn btn-primary btn-sm"
                                                            style={{ padding: '4px 10px', fontSize: 12 }}
                                                            onClick={() => handleDownload(task.task_id, video.video_id)}
                                                        >
                                                            ⬇ 下载
                                                        </button>
                                                    )}
                                                    {video.status === 'failed' && video.error_message && (
                                                        <span style={{ fontSize: 11, color: 'var(--color-accent-red)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={video.error_message}>
                                                            {video.error_message}
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
