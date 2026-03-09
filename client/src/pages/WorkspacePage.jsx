import { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { useNavigate } from 'react-router-dom';
import { templateAPI, taskAPI } from '../services/api';
import { useToast } from '../App';

const API_BASE = import.meta.env.VITE_API_URL || '';
const MAX_VIDEO_FILES = 20;
const MAX_VIDEO_SIZE = 500 * 1024 * 1024;

const VIDEO_ACCEPT = {
    'video/mp4': ['.mp4', '.m4v'],
    'video/quicktime': ['.mov'],
    'video/x-msvideo': ['.avi'],
    'video/x-matroska': ['.mkv'],
    'video/webm': ['.webm'],
    'video/3gpp': ['.3gp'],
    'application/octet-stream': ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'],
};

function getDropzoneErrorMessage(errorCode) {
    if (errorCode === 'file-too-large') {
        return `文件超过 ${Math.round(MAX_VIDEO_SIZE / 1024 / 1024)}MB`;
    }
    if (errorCode === 'file-invalid-type') {
        return '格式不支持（支持 MP4/MOV/AVI/MKV/WebM/M4V/3GP）';
    }
    if (errorCode === 'too-many-files') {
        return `超出数量限制（最多 ${MAX_VIDEO_FILES} 个）`;
    }
    return '文件不符合上传要求';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export default function WorkspacePage() {
    const [templates, setTemplates] = useState([]);
    const [selectedTemplates, setSelectedTemplates] = useState([]);
    const [filterType, setFilterType] = useState('');
    const [videoFiles, setVideoFiles] = useState([]);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [showRejectedModal, setShowRejectedModal] = useState(false);
    const [rejectedFileDetails, setRejectedFileDetails] = useState([]);
    const toast = useToast();
    const navigate = useNavigate();

    useEffect(() => {
        loadTemplates();
    }, [filterType]);

    const loadTemplates = async () => {
        try {
            const res = await templateAPI.list(filterType || undefined);
            setTemplates(res.data.templates);
        } catch (_err) {
            toast('加载模板失败', 'error');
        }
    };

    const onDrop = useCallback((acceptedFiles, rejectedFiles) => {
        const remainingSlots = Math.max(MAX_VIDEO_FILES - videoFiles.length, 0);
        const acceptedWithinLimit = acceptedFiles.slice(0, remainingSlots);
        const overflowAccepted = acceptedFiles.slice(remainingSlots);

        const mergedRejected = [
            ...rejectedFiles,
            ...overflowAccepted.map((file) => ({
                file,
                errors: [{ code: 'too-many-files' }],
            })),
        ];

        if (mergedRejected.length > 0) {
            const details = mergedRejected.map((item) => {
                const reasons = item.errors.map((err) => getDropzoneErrorMessage(err.code));
                return {
                    name: item.file.name,
                    reasons: Array.from(new Set(reasons)),
                };
            });

            setRejectedFileDetails(details);
            setShowRejectedModal(true);

            const rejectedNames = details.map((item) => item.name).slice(0, 3).join('、');
            const tooLarge = mergedRejected.some((item) =>
                item.errors.some((err) => err.code === 'file-too-large')
            );
            const tooMany = mergedRejected.some((item) =>
                item.errors.some((err) => err.code === 'too-many-files')
            );
            const reason = tooLarge
                ? `文件超过 ${Math.round(MAX_VIDEO_SIZE / 1024 / 1024)}MB`
                : tooMany
                    ? `超出 ${MAX_VIDEO_FILES} 个文件上限`
                : '格式不支持（支持 MP4/MOV/AVI/MKV/WebM/M4V/3GP）';
            toast(`有 ${details.length} 个文件未加入：${rejectedNames}${details.length > 3 ? '...' : ''}，原因：${reason}`, 'error');
        }

        if (acceptedWithinLimit.length > 0) {
            setVideoFiles((prev) => [...prev, ...acceptedWithinLimit]);
        }
    }, [videoFiles, toast]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: VIDEO_ACCEPT,
        maxSize: MAX_VIDEO_SIZE,
        multiple: true,
    });

    const removeFile = (index) => {
        setVideoFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const handleSubmit = async () => {
        if (selectedTemplates.length === 0) {
            toast('请先选择至少一个模板', 'error');
            return;
        }
        if (videoFiles.length === 0) {
            toast('请先上传视频文件', 'error');
            return;
        }

        setUploading(true);
        setUploadProgress(0);

        const formData = new FormData();
        const templateIds = selectedTemplates.map(t => t.id).join(',');
        formData.append('templateIds', templateIds);
        videoFiles.forEach((file) => {
            formData.append('videos', file);
        });

        try {
            await taskAPI.create(formData, (progressEvent) => {
                const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                setUploadProgress(percent);
            });

            toast(`已提交 ${videoFiles.length} 个视频到处理队列！`, 'success');
            setVideoFiles([]);
            navigate('/tasks');
        } catch (err) {
            toast(err.response?.data?.error || '提交失败', 'error');
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="page-container animate-fade-in">
            <div className="page-header">
                <h1 className="page-title">工作台</h1>
                <p className="page-subtitle">上传 9:16 竖版视频，选择模板快速生成不同尺寸的成品</p>
            </div>

            <div className="workspace-grid">
                {/* Left: Video Upload */}
                <div className="card">
                    <div className="card-header">
                        <h2 className="card-title">📹 上传视频</h2>
                        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                            {videoFiles.length}/20 个文件
                        </span>
                    </div>

                    <div
                        {...getRootProps()}
                        className={`dropzone ${isDragActive ? 'active' : ''}`}
                    >
                        <input {...getInputProps()} />
                        <div className="dropzone-icon">📁</div>
                        <div className="dropzone-text">
                            {isDragActive ? '放开以添加视频' : '拖拽视频到此处，或点击选择文件'}
                        </div>
                        <div className="dropzone-hint">
                            支持 MP4、MOV、AVI、MKV、WebM、M4V、3GP · 单个最大 500MB · 最多 20 个
                        </div>
                    </div>

                    {videoFiles.length > 0 && (
                        <div className="file-list">
                            {videoFiles.map((file, i) => (
                                <div key={i} className="file-item">
                                    <span>🎬</span>
                                    <span className="file-name">{file.name}</span>
                                    <span className="file-size">{formatFileSize(file.size)}</span>
                                    <button className="file-remove" onClick={() => removeFile(i)}>✕</button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Right: Template Selection */}
                <div className="card">
                    <div className="card-header">
                        <h2 className="card-title">🖼 选择模板 (可多选)</h2>
                        <select
                            className="form-select"
                            style={{ width: 120 }}
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                        >
                            <option value="">全部类型</option>
                            <option value="1:1">1:1 正方形</option>
                            <option value="16:9">16:9 横版</option>
                            <option value="9:16">9:16 覆盖</option>
                        </select>
                    </div>

                    {templates.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">🖼</div>
                            <div className="empty-title">暂无模板</div>
                            <div className="empty-desc">请先到模板库上传模板</div>
                            <button className="btn btn-primary btn-sm" onClick={() => navigate('/templates')}>
                                去上传模板
                            </button>
                        </div>
                    ) : (
                        <div className="template-grid" style={{ maxHeight: 400, overflowY: 'auto' }}>
                            {templates.map((tpl) => (
                                <div
                                    key={tpl.id}
                                    className={`template-card ${selectedTemplates.some(t => t.id === tpl.id) ? 'selected' : ''}`}
                                    onClick={() => {
                                        setSelectedTemplates(prev => {
                                            const isSelected = prev.some(t => t.id === tpl.id);
                                            if (isSelected) {
                                                return prev.filter(t => t.id !== tpl.id);
                                            } else {
                                                return [...prev, tpl];
                                            }
                                        });
                                    }}
                                >
                                    <div className="template-preview">
                                        <img
                                            src={`${API_BASE}/uploads/${tpl.file_path}`}
                                            alt={tpl.name}
                                            loading="lazy"
                                        />
                                    </div>
                                    <div className="template-info">
                                        <div className="template-name">{tpl.name}</div>
                                        <div className="template-type">{tpl.type} · {tpl.width}×{tpl.height}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Submit Button */}
            <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
                <button
                    className="btn btn-primary btn-lg"
                    onClick={handleSubmit}
                    disabled={uploading || selectedTemplates.length === 0 || videoFiles.length === 0}
                    style={{ minWidth: 240, fontSize: 16 }}
                >
                    {uploading ? '上传中...' : `🚀 提交处理 (${videoFiles.length} 个视频 × ${selectedTemplates.length} 个模板 = ${videoFiles.length * selectedTemplates.length} 个任务)`}
                </button>
            </div>

            {/* Upload Progress Overlay */}
            {uploading && (
                <div className="upload-progress-overlay">
                    <div className="upload-progress-card">
                        <div className="upload-icon">📤</div>
                        <h3 style={{ marginBottom: 12 }}>正在上传视频文件...</h3>
                        <div className="progress-bar" style={{ marginBottom: 8 }}>
                            <div className="progress-fill" style={{ width: `${uploadProgress}%` }}></div>
                        </div>
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>
                            {uploadProgress}%
                        </div>
                    </div>
                </div>
            )}

            {/* Rejected Files Detail Modal */}
            {showRejectedModal && (
                <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowRejectedModal(false)}>
                    <div className="modal">
                        <h2 className="modal-title">以下文件未加入上传列表</h2>
                        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 10 }}>
                            {rejectedFileDetails.map((item, index) => (
                                <div key={`${item.name}-${index}`} style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-border-soft)' }}>
                                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                                        {index + 1}. {item.name}
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--color-accent-red)', marginTop: 4 }}>
                                        {item.reasons.join('；')}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowRejectedModal(false)}>关闭</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
