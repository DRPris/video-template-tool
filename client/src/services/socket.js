import { io } from 'socket.io-client';

// 开发环境默认连接本地后端，避免误连到 Vite 前端端口。
const SOCKET_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin);

let socket = null;

export function connectSocket() {
    const token = localStorage.getItem('token');
    if (!token) return null;

    if (socket?.connected) return socket;

    socket = io(SOCKET_URL, {
        auth: { token },
        transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
        console.log('🔌 WebSocket connected');
    });

    socket.on('disconnect', () => {
        console.log('🔌 WebSocket disconnected');
    });

    socket.on('connect_error', (err) => {
        console.error('WebSocket connection error:', err.message);
    });

    return socket;
}

export function disconnectSocket() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
}

export function getSocket() {
    return socket;
}
