import express from 'express';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const DIST_DIR = path.join(__dirname, 'dist');

// Security headers for every response. The CSP only allows what the Vite
// bundle actually loads: same-origin assets, Google Fonts, https images
// (map tiles, backend-served files), and https/wss connections to the
// configured API. `frame-ancestors 'none'` blocks clickjacking of the
// authenticated dashboard.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'self' blob:",
].join('; ');

export function createApp({ distDir = DIST_DIR } = {}) {
  const app = express();

  // Render terminates TLS one hop in front of this process; trust that single
  // hop so `req.secure` reflects X-Forwarded-Proto and HSTS is only emitted
  // for real HTTPS requests (never for plain-HTTP local development).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    }
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Fingerprinted Vite assets are safe to cache long. index.html is NOT
  // fingerprinted, so it must never be cached — otherwise a deploy would leave
  // browsers on a stale shell that references deleted hashed assets.
  app.use(express.static(distDir, {
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  // SPA fallback — client-side routes (/, /login, /rides/active, ...) return
  // index.html so React Router renders them on refresh/direct access instead of
  // Render answering "Not Found". Only GET/HEAD HTML navigation is rewritten;
  // API calls and static asset paths are never intercepted.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    if (path.extname(req.path)) return next();
    if (!req.accepts('html')) return next();
    res.sendFile(path.join(distDir, 'index.html'), {
      headers: { 'Cache-Control': 'no-cache' },
    });
  });

  return app;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  createApp().listen(PORT, () => {
    console.log(`Admin dashboard server running on port ${PORT}`);
  });
}
