import axios from 'axios';

const API_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000') + '/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('sponsor_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('sponsor_token');
      localStorage.removeItem('sponsor_user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;