import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5174;
const DIST_DIR = path.join(__dirname, 'dist');

// Fingerprinted Vite assets are safe to cache long. index.html is NOT
// fingerprinted, so it must never be cached — otherwise a deploy would leave
// browsers on a stale shell that references deleted hashed assets.
app.use(express.static(DIST_DIR, {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback — client-side routes (/, /login, /forgot-password, ...) return
// index.html so React Router renders them on refresh/direct access instead of
// Render answering "Not Found". Only GET/HEAD HTML navigation is rewritten;
// API calls and static asset paths are never intercepted.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next();
  if (!req.accepts('html')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'), {
    headers: { 'Cache-Control': 'no-cache' },
  });
});

app.listen(PORT, () => {
  console.log(`NetRide partner portal running on port ${PORT}`);
});