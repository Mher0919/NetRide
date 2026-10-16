import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5174;
const DIST_DIR = path.join(__dirname, 'dist');

// Security headers for every response. The CSP additionally allows the
// Stripe.js script + Payment Element iframe (js.stripe.com / hooks.stripe.com)
// used by the funding flow. Outbound https/wss stays open for the
// environment-configured API (Stripe's own XHRs go over https).
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'self' blob:",
].join('; ');

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

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