import axios from 'axios';

const API_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000') + '/api';

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

// Resolve /api/files/{id} relative URLs to fully-qualified URLs using the API base.
function resolveFileUrls(obj: any): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string' && obj[i].startsWith('/api/files/')) {
        obj[i] = API_URL + obj[i];
      } else if (obj[i] !== null && typeof obj[i] === 'object') {
        resolveFileUrls(obj[i]);
      }
    }
  } else if (obj !== null && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && val.startsWith('/api/files/')) {
        obj[key] = API_URL + val;
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
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('admin_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
