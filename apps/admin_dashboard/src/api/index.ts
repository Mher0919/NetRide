import axios from 'axios';

const API_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000') + '/api';

// Strip trailing /api for resolving /api/files/{id} relative URLs.
// API_URL already includes /api, so API_ORIGIN is just the origin.
const API_ORIGIN = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

// Resolve a backend-relative URL (e.g. /api/places/photo?...) to an absolute
// URL usable by <img>. Absolute URLs pass through untouched.
export function resolveApiUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return API_ORIGIN + (path.startsWith('/') ? path : `/${path}`);
}

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add a request interceptor to add the auth token to headers
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Resolve /api/files/{id} relative URLs to fully-qualified URLs.
// Uses API_ORIGIN (without trailing /api) to avoid double /api.
function resolveFileUrls(obj: any): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string' && obj[i].startsWith('/api/files/')) {
        obj[i] = API_ORIGIN + obj[i];
      } else if (obj[i] !== null && typeof obj[i] === 'object') {
        resolveFileUrls(obj[i]);
      }
    }
  } else if (obj !== null && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && val.startsWith('/api/files/')) {
        obj[key] = API_ORIGIN + val;
      } else if (val !== null && typeof val === 'object') {
        resolveFileUrls(val);
      }
    }
  }
}

// Add a response interceptor to handle unauthorized errors and resolve file URLs
api.interceptors.response.use(
  (response) => {
    if (response.data !== null && response.data !== undefined) {
      resolveFileUrls(response.data);
    }
    return response;
  },
  (error) => {
    // Public auth endpoints are handled by the login page (which shows the
    // actual error) — a 401 there must NOT bounce the user to /login.
    const url = error.config?.url ?? '';
    const isPublicAuth = /\/auth\/(login-password|admin\/request-2fa|admin\/verify-2fa|forgot-password|reset-password|request-otp|verify-otp)$/.test(url);
    if (error.response && error.response.status === 401 && !isPublicAuth) {
      localStorage.removeItem('admin_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
