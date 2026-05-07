import { useState, useEffect, useCallback, useRef } from 'react';
import { resizeAPI } from '../services/api';
import { getSocket } from '../services/socket';
import { useToast } from '../App';

const RATIO_OPTIONS = [
    { value: '1:1', label: '1:1 方形', icon: '⬜', desc: '1080×1080' },
    { value: '16:9', label: '16:9 横版', icon: '🖥', desc: '1920×1080' },
    { value: '9:16', label: '9:16 竖版', icon: '📱', desc: '1080×1920' },
];

const MODE_OPTIONS = [
    { value: 'center', label: '居中裁剪', icon: '✂️', desc: '固定居中裁切，快速稳定' },
    { value: 'smart', label: '智能裁切', icon: '🧠', desc: '显著性分析 + 场景感知 + 人脸追踪' },
];

const STATUS_MAP = {
    queued: { text: '排队中', color: '#6b7280', icon: '⏳' },
    processing: { text: '处理中', color: '#3b82f6', icon: '⚙️' },
    completed: { text: '已完成', color: '#10b981', icon: '✅' },
    failed: { text: '失败', color: '#ef4444', icon: '❌' },
};

function ResizePage() {
    const addToast = useToast();

    // 上传区
    const [files, setFiles] = useState([]);
    const [targetRatio, setTargetRatio] = useState('');
    const [mode, setMode] = useState('center');
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const fileInputRef = useRef(null);

    // 任务列表
    const [tasks, setTasks] = useState([]);
    const [expandedTask, setExpandedTask] = useState(null);
    const [taskVideos, setTaskVideos] = useState({});

    // 加载任务列表
    const loadTasks = useCallback(async () => {
        try {
            const res = await resizeAPI.list();
            setTasks(res.data.tasks || []);
        } catch (err) {
            console.error('加载任务失败:', err);
        }
    }, []);

    useEffect(() => {
        loadTasks();
    }, [loadTasks]);

    // WebSocket 实时进度
    useEffect(() => {
        const socket = getSocket();
        if (!socket) return;

        const handler = (data) => {
            if (data.videoId) {
                setTaskVideos((prev) => {
                    const videos = prev[data.taskId] || [];
                    const idx = videos.findIndex((v) => v.video_id === data.videoId);
                    if (idx >= 0) {
                        const updated = [...videos];
                        updated[idx] = {
                            ...updated[idx],
                            status: data.status,
                            progress_percent: data.progress || updated[idx].progress_percent,
                            error_message: data.error || updated[idx].error_message,
                        };
                        return { ...prev, [data.taskId]: updated };
                    }
                    return prev;
                });
            }
            if (data.status === 'completed' || data.status === 'failed') {
                loadTasks();
            }
        };

        socket.on('resize:progress', handler);
        return () => socket.off('resize:progress', handler);
    }, [loadTasks]);

    // 文件选择
    const handleFileSelect = (e) => {
        const selected = Array.from(e.target.files || []);
        if (selected.length > 20) {
            addToast('单次最多上传20个视频', 'error');
            return;
        }
        setFiles(selected);
    };

    // 拖拽上传
    const handleDrop = (e) => {
        e.preventDefault();
        const dropped = Array.from(e.dataTransfer.files).filter((f) =>
            /\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/i.test(f.name)
        );
        if (dropped.length > 20) {
            addToast('单次最多上传20个视频', 'error');
            return;
        }
        setFiles(dropped);
    };

    // 提交任务
    const handleSubmit = async () => {
        if (files.length === 0) {
            addToast('请先选择视频文件', 'error');
            return;
        }
        if (!targetRatio) {
            addToast('请选择目标比例', 'error');
            return;
        }

        setUploading(true);
        setUploadProgress(0);

        try {
            const formData = new FormData();
            files.forEach((f) => formData.append('videos', f));
            formData.append('targetRatio', targetRatio);
            formData.append('mode', mode);

            await resizeAPI.create(formData, (e) => {
                if (e.total) setUploadProgress(Math.round((e.loaded / e.total) * 100));
            });

            addToast(`已提交 ${files.length} 个视频进行 Resize`, 'success');
            setFiles([]);
            setTargetRatio('');
            if (fileInputRef.current) fileInputRef.current.value = '';
            loadTasks();
        } catch (err) {
            addToast(err.response?.data?.error || 'Resize 任务创建失败', 'error');
        } finally {
            setUploading(false);
            setUploadProgress(0);
        }
    };

    // 展开任务详情
    const toggleTask = async (taskId) => {
        if (expandedTask === taskId) {
            setExpandedTask(null);
            return;
        }
        setExpandedTask(taskId);
        try {
            const res = await resizeAPI.get(taskId);
            setTaskVideos((prev) => ({ ...prev, [taskId]: res.data.videos }));
        } catch (err) {
            addToast('加载任务详情失败', 'error');
        }
    };

    // 重试
    const handleRetry = async (taskId) => {
        try {
            await resizeAPI.retry(taskId);
            addToast('已重新提交失败视频', 'success');
            loadTasks();
        } catch (err) {
            addToast(err.response?.data?.error || '重试失败', 'error');
        }
    };

    // 删除
    const handleDelete = async (taskId) => {
        if (!window.confirm('确定删除此任务及所有相关文件？')) return;
        try {
            await resizeAPI.delete(taskId);
            addToast('任务已删除', 'success');
            loadTasks();
        } catch (err) {
            addToast(err.response?.data?.error || '删除失败', 'error');
        }
    };

    // 下载（使用 fetch + blob 确保走正确的后端地址）
    const handleDownload = async (taskId, videoId) => {
        try {
            const url = resizeAPI.downloadUrl(taskId, videoId);
            const token = localStorage.getItem('token');
            const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!resp.ok) {
                addToast('下载失败: 文件不存在或未处理完成', 'error');
                return;
            }

            const blob = await resp.blob();
            const contentDisposition = resp.headers.get('content-disposition') || '';
            const filenameMatch = contentDisposition.match(/filename="?(.+?)"?$/);
            const filename = filenameMatch ? filenameMatch[1] : `video_${videoId}.mp4`;

            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch (err) {
            addToast('下载失败: ' + err.message, 'error');
        }
    };

    const handleDownloadAll = async (taskId) => {
        try {
            const url = resizeAPI.downloadAllUrl(taskId);
            const token = localStorage.getItem('token');
            const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!resp.ok) {
                addToast('批量下载失败', 'error');
                return;
            }

            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `resize_${taskId.slice(0, 8)}_videos.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch (err) {
            addToast('批量下载失败: ' + err.message, 'error');
        }
    };

    return (
        <div className="resize-page">
            <div className="page-header">
                <h1>🔄 视频 Resize</h1>
                <p className="page-subtitle">智能调整视频比例，支持多种尺寸互转</p>
            </div>

            {/* 上传区 */}
            <div className="resize-upload-section card">
                <h2>创建 Resize 任务</h2>

                {/* 文件选择 */}
                <div
                    className="resize-dropzone"
                    onDrop={handleDrop}
                    onDragOver={(e) => e.preventDefault()}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        multiple
                        onChange={handleFileSelect}
                        style={{ display: 'none' }}
                    />
                    {files.length > 0 ? (
                        <div className="resize-file-list">
                            <div className="resize-file-count">
                                🎬 已选择 {files.length} 个视频
                            </div>
                            {files.slice(0, 5).map((f, i) => (
                                <div key={i} className="resize-file-item">
                                    {f.name} ({(f.size / 1024 / 1024).toFixed(1)} MB)
                                </div>
                            ))}
                            {files.length > 5 && (
                                <div className="resize-file-item">...还有 {files.length - 5} 个文件</div>
                            )}
                        </div>
                    ) : (
                        <div className="resize-dropzone-hint">
                            <div style={{ fontSize: 40, marginBottom: 8 }}>📁</div>
                            <div>点击选择或拖拽视频文件到此处</div>
                            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                                支持 MP4, MOV, AVI, MKV, WebM · 最多 20 个
                            </div>
                        </div>
                    )}
                </div>

                {/* 目标比例选择 */}
                <div className="resize-options">
                    <h3>目标比例</h3>
                    <div className="resize-ratio-grid">
                        {RATIO_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                className={`resize-ratio-btn ${targetRatio === opt.value ? 'active' : ''}`}
                                onClick={() => setTargetRatio(opt.value)}
                            >
                                <span className="ratio-icon">{opt.icon}</span>
                                <span className="ratio-label">{opt.label}</span>
                                <span className="ratio-desc">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* 裁切模式 */}
                <div className="resize-options">
                    <h3>裁切模式</h3>
                    <div className="resize-mode-grid">
                        {MODE_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                className={`resize-mode-btn ${mode === opt.value ? 'active' : ''} ${opt.disabled ? 'disabled' : ''}`}
                                onClick={() => !opt.disabled && setMode(opt.value)}
                                disabled={opt.disabled}
                            >
                                <span className="mode-icon">{opt.icon}</span>
                                <span className="mode-label">{opt.label}</span>
                                <span className="mode-desc">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* 提交按钮 */}
                <button
                    className="btn btn-primary resize-submit-btn"
                    onClick={handleSubmit}
                    disabled={uploading || files.length === 0 || !targetRatio}
                >
                    {uploading ? (
                        <>上传中 {uploadProgress}%</>
                    ) : (
                        <>🚀 开始 Resize ({files.length} 个视频)</>
                    )}
                </button>

                {uploading && (
                    <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
                    </div>
                )}
            </div>

            {/* 任务列表 */}
            <div className="resize-tasks-section">
                <h2>Resize 任务列表</h2>
                {tasks.length === 0 ? (
                    <div className="empty-state">
                        <div style={{ fontSize: 48 }}>📭</div>
                        <p>暂无 Resize 任务</p>
                    </div>
                ) : (
                    <div className="resize-tasks-list">
                        {tasks.map((task) => {
                            const st = STATUS_MAP[task.status] || STATUS_MAP.queued;
                            const videos = taskVideos[task.task_id] || [];
                            const isExpanded = expandedTask === task.task_id;

                            return (
                                <div key={task.task_id} className="resize-task-card card">
                                    <div
                                        className="resize-task-header"
                                        onClick={() => toggleTask(task.task_id)}
                                    >
                                        <div className="resize-task-info">
                                            <span className="resize-task-status" style={{ color: st.color }}>
                                                {st.icon} {st.text}
                                            </span>
                                            <span className="resize-task-ratio">
                                                {task.source_ratio} → {task.target_ratio}
                                            </span>
                                            <span className="resize-task-mode">
                                                {task.mode === 'center' ? '✂️ 居中' : '🧠 智能'}
                                            </span>
                                            <span className="resize-task-count">
                                                {task.completed_videos}/{task.total_videos} 完成
                                            </span>
                                        </div>
                                        <div className="resize-task-actions">
                                            <span className="resize-task-time">
                                                {new Date(task.created_at).toLocaleString()}
                                            </span>
                                            <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                                        </div>
                                    </div>

                                    {/* 任务进度条 */}
                                    {task.status === 'processing' && (
                                        <div className="progress-bar" style={{ margin: '8px 16px' }}>
                                            <div
                                                className="progress-fill"
                                                style={{
                                                    width: `${Math.round((task.completed_videos / task.total_videos) * 100)}%`,
                                                }}
                                            />
                                        </div>
                                    )}

                                    {/* 展开详情 */}
                                    {isExpanded && (
                                        <div className="resize-task-detail">
                                            <div className="resize-task-toolbar">
                                                {task.failed_videos > 0 && (
                                                    <button
                                                        className="btn btn-sm"
                                                        onClick={() => handleRetry(task.task_id)}
                                                    >
                                                        🔄 重试失败
                                                    </button>
                                                )}
                                                {task.completed_videos > 0 && (
                                                    <button
                                                        className="btn btn-sm btn-success"
                                                        onClick={() => handleDownloadAll(task.task_id)}
                                                    >
                                                        📦 全部下载
                                                    </button>
                                                )}
                                                <button
                                                    className="btn btn-sm btn-danger"
                                                    onClick={() => handleDelete(task.task_id)}
                                                >
                                                    🗑 删除
                                                </button>
                                            </div>

                                            <div className="resize-video-list">
                                                {videos.map((v) => {
                                                    const vs = STATUS_MAP[v.status] || STATUS_MAP.queued;
                                                    return (
                                                        <div key={v.video_id} className="resize-video-item">
                                                            <div className="resize-video-name">
                                                                🎬 {v.original_filename}
                                                            </div>
                                                            <div className="resize-video-meta">
                                                                {v.source_width > 0 && (
                                                                    <span>{v.source_width}×{v.source_height}</span>
                                                                )}
                                                                <span style={{ color: vs.color }}>
                                                                    {vs.icon} {vs.text}
                                                                    {v.status === 'processing' && ` ${v.progress_percent}%`}
                                                                </span>
                                                                {v.status === 'completed' && (
                                                                    <button
                                                                        className="btn btn-sm"
                                                                        onClick={() => handleDownload(task.task_id, v.video_id)}
                                                                    >
                                                                        ⬇ 下载
                                                                    </button>
                                                                )}
                                                                {v.status === 'failed' && v.error_message && (
                                                                    <span className="resize-error">{v.error_message}</span>
                                                                )}
                                                            </div>
                                                            {v.status === 'processing' && (
                                                                <div className="progress-bar progress-bar-sm">
                                                                    <div
                                                                        className="progress-fill"
                                                                        style={{ width: `${v.progress_percent}%` }}
                                                                    />
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

export default ResizePage;
