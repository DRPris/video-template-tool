import axios from 'axios';

// 开发环境默认走本地后端 3000，避免 Vite 开发服务器把 /api 当成前端路由处理。
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '');

const api = axios.create({
    baseURL: `${API_BASE}/api`,
    timeout: 30000,
});

// Add token to requests
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Handle auth errors
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/login';
        }
        return Promise.reject(error);
    }
);

// Auth API
export const authAPI = {
    login: (username, password) => api.post('/auth/login', { username, password }),
    register: (username, password, displayName) => api.post('/auth/register', { username, password, displayName }),
    getMe: () => api.get('/auth/me'),
};

// Template API
export const templateAPI = {
    list: (type) => api.get('/templates', { params: { type } }),
    get: (id) => api.get(`/templates/${id}`),
    create: (formData) => api.post('/templates', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    }),
    update: (id, data) => api.put(`/templates/${id}`, data),
    delete: (id) => api.delete(`/templates/${id}`),
};

// Task API
export const taskAPI = {
    create: (formData, onProgress) => api.post('/tasks', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300000, // 5 min for upload
        onUploadProgress: onProgress,
    }),
    list: () => api.get('/tasks'),
    get: (id) => api.get(`/tasks/${id}`),
    retry: (id) => api.post(`/tasks/${id}/retry`),
    delete: (id) => api.delete(`/tasks/${id}`),
    downloadUrl: (taskId, videoId) => `${API_BASE}/api/tasks/${taskId}/download/${videoId}`,
    downloadAllUrl: (taskId) => `${API_BASE}/api/tasks/${taskId}/download-all`,
};

export default api;
