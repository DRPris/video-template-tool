import { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { templateAPI } from '../services/api';
import { useToast } from '../App';

const API_BASE = import.meta.env.VITE_API_URL || '';

const TYPE_INFO = {
    '1:1': { label: '1:1 正方形', dims: '1080×1080', defaultVA: { x: 0, y: 60, w: 540, h: 960 } },
    '16:9': { label: '16:9 横版', dims: '1920×1080', defaultVA: { x: 656, y: 0, w: 608, h: 1080 } },
    '9:16': { label: '9:16 覆盖', dims: '1080×1920', defaultVA: { x: 0, y: 0, w: 1080, h: 1920 } },
};

export default function TemplatesPage() {
    const [templates, setTemplates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showUpload, setShowUpload] = useState(false);
    const [filterType, setFilterType] = useState('');
    const toast = useToast();

    // Upload form state
    const [uploadFiles, setUploadFiles] = useState([]);
    const [uploadName, setUploadName] = useState('');
    const [uploadType, setUploadType] = useState('1:1');
    const [videoArea, setVideoArea] = useState(TYPE_INFO['1:1'].defaultVA);
    const [uploading, setUploading] = useState(false);

    const loadTemplates = useCallback(async () => {
        try {
            const res = await templateAPI.list(filterType || undefined);
            setTemplates(res.data.templates);
        } catch (err) {
            toast('加载模板失败', 'error');
        } finally {
            setLoading(false);
        }
    }, [filterType, toast]);

    useEffect(() => {
        loadTemplates();
    }, [loadTemplates]);

    useEffect(() => {
        setVideoArea(TYPE_INFO[uploadType]?.defaultVA || TYPE_INFO['1:1'].defaultVA);
    }, [uploadType]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop: (files) => {
            if (files.length > 0) {
                setUploadFiles(files);
                if (!uploadName && files.length === 1) {
                    setUploadName(files[0].name.replace(/\.[^.]+$/, ''));
                }
            }
        },
        accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'] },
        maxFiles: 20,
        multiple: true,
    });

    const handleUpload = async () => {
        if (uploadFiles.length === 0) { toast('请选择模板图片', 'error'); return; }

        setUploading(true);
        try {
            for (let i = 0; i < uploadFiles.length; i++) {
                const file = uploadFiles[i];
                let name = file.name.replace(/\.[^.]+$/, '');
                if (uploadFiles.length === 1 && uploadName.trim()) {
                    name = uploadName.trim();
                } else if (uploadFiles.length > 1 && uploadName.trim()) {
                    name = `${uploadName.trim()}-${i + 1}`;
                }

                const formData = new FormData();
                formData.append('file', file);
                formData.append('name', name);
                formData.append('type', uploadType);
                formData.append('videoAreaX', videoArea.x);
                formData.append('videoAreaY', videoArea.y);
                formData.append('videoAreaWidth', videoArea.w);
                formData.append('videoAreaHeight', videoArea.h);

                await templateAPI.create(formData);
            }
            toast(`成功上传 ${uploadFiles.length} 个模板！`, 'success');
            setShowUpload(false);
            setUploadFiles([]);
            setUploadName('');
            loadTemplates();
        } catch (err) {
            toast(err.response?.data?.error || '上传失败', 'error');
        } finally {
            setUploading(false);
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('确定要删除这个模板吗？')) return;
        try {
            await templateAPI.delete(id);
            toast('模板已删除', 'success');
            setTemplates((prev) => prev.filter((t) => t.id !== id));
        } catch (err) {
            toast(err.response?.data?.error || '删除失败', 'error');
        }
    };

    return (
        <div className="page-container animate-fade-in">
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <h1 className="page-title">模板库</h1>
                    <p className="page-subtitle">管理视频合成模板（支持 PNG/JPG/JPEG/WebP 格式）</p>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                    <select
                        className="form-select"
                        style={{ width: 140 }}
                        value={filterType}
                        onChange={(e) => setFilterType(e.target.value)}
                    >
                        <option value="">全部类型</option>
                        <option value="1:1">1:1 正方形</option>
                        <option value="16:9">16:9 横版</option>
                        <option value="9:16">9:16 覆盖</option>
                    </select>
                    <button className="btn btn-primary" onClick={() => setShowUpload(true)}>
                        ➕ 上传模板
                    </button>
                </div>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-secondary)' }}>
                    加载中...
                </div>
            ) : templates.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-icon">🖼️</div>
                    <div className="empty-title">暂无模板</div>
                    <div className="empty-desc">上传模板图片（PNG/JPG/JPEG/WebP），PNG 透明区域为视频显示区域</div>
                    <button className="btn btn-primary" onClick={() => setShowUpload(true)}>
                        上传第一个模板
                    </button>
                </div>
            ) : (
                <div className="template-grid">
                    {templates.map((tpl) => {
                        const info = TYPE_INFO[tpl.type] || {};
                        return (
                            <div key={tpl.id} className="template-card" style={{ cursor: 'default' }}>
                                <div className="template-preview">
                                    <img
                                        src={`${API_BASE}/uploads/${tpl.file_path}`}
                                        alt={tpl.name}
                                        loading="lazy"
                                    />
                                </div>
                                <div className="template-info">
                                    <div className="template-name">{tpl.name}</div>
                                    <div className="template-type">
                                        {info.label || tpl.type} · {tpl.width}×{tpl.height}
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                                        视频区域: ({tpl.video_area_x},{tpl.video_area_y}) {tpl.video_area_width}×{tpl.video_area_height}
                                    </div>
                                    <div style={{ marginTop: 10 }}>
                                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(tpl.id)}>
                                            删除
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Upload Modal */}
            {showUpload && (
                <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowUpload(false)}>
                    <div className="modal">
                        <h2 className="modal-title">上传新模板</h2>

                        <div className="form-group">
                            <label className="form-label">模板名称前缀（可选，批量上传时自动加编号，不填默认文件名）</label>
                            <input
                                className="form-input"
                                type="text"
                                placeholder="例如：品牌宣传-蓝色"
                                value={uploadName}
                                onChange={(e) => setUploadName(e.target.value)}
                            />
                        </div>

                        <div className="form-group">
                            <label className="form-label">模板类型</label>
                            <select
                                className="form-select"
                                value={uploadType}
                                onChange={(e) => setUploadType(e.target.value)}
                            >
                                {Object.entries(TYPE_INFO).map(([key, info]) => (
                                    <option key={key} value={key}>
                                        {info.label}（{info.dims}）
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="form-group">
                            <label className="form-label">模板图片（支持 PNG/JPG/JPEG/WebP）</label>
                            <div
                                {...getRootProps()}
                                className={`dropzone ${isDragActive ? 'active' : ''}`}
                                style={{ padding: 20 }}
                            >
                                <input {...getInputProps()} />
                                {uploadFiles.length > 0 ? (
                                    <div>
                                        <span>✅ 已选中 {uploadFiles.length} 个文件</span>
                                        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                                            {uploadFiles.map(f => f.name).join(', ').slice(0, 50)}...
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                                            点击或拖拽新文件会替换当前选择
                                        </div>
                                    </div>
                                ) : (
                                    <div>
                                        <div style={{ fontSize: 28, marginBottom: 8 }}>🖼️</div>
                                        <div style={{ fontSize: 14 }}>拖拽或点击选择图片（PNG/JPG/JPEG/WebP，支持多选）</div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="form-group">
                            <label className="form-label">视频区域坐标（像素）</label>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                <div>
                                    <label className="form-label" style={{ fontSize: 11 }}>X 起点</label>
                                    <input className="form-input" type="number" value={videoArea.x}
                                        onChange={(e) => setVideoArea((v) => ({ ...v, x: parseInt(e.target.value) || 0 }))} />
                                </div>
                                <div>
                                    <label className="form-label" style={{ fontSize: 11 }}>Y 起点</label>
                                    <input className="form-input" type="number" value={videoArea.y}
                                        onChange={(e) => setVideoArea((v) => ({ ...v, y: parseInt(e.target.value) || 0 }))} />
                                </div>
                                <div>
                                    <label className="form-label" style={{ fontSize: 11 }}>宽度</label>
                                    <input className="form-input" type="number" value={videoArea.w}
                                        onChange={(e) => setVideoArea((v) => ({ ...v, w: parseInt(e.target.value) || 0 }))} />
                                </div>
                                <div>
                                    <label className="form-label" style={{ fontSize: 11 }}>高度</label>
                                    <input className="form-input" type="number" value={videoArea.h}
                                        onChange={(e) => setVideoArea((v) => ({ ...v, h: parseInt(e.target.value) || 0 }))} />
                                </div>
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6 }}>
                                定义视频在模板中的显示位置和大小，从模板左上角 (0,0) 开始计算
                            </div>
                        </div>

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowUpload(false)}>取消</button>
                            <button className="btn btn-primary" onClick={handleUpload} disabled={uploading}>
                                {uploading ? '上传中...' : '确认上传'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
