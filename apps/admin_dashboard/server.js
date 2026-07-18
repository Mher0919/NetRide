import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5173;
const DIST_DIR = path.join(__dirname, 'dist');

// Cache-control for static assets (fingerprinted by Vite — safe to cache long)
app.use(express.static(DIST_DIR, {
  maxAge: '1y',
  immutable: true,
}));

// SPA fallback — any request for an unknown path returns index.html.
// Must come AFTER express.static so actual files are served first.
// Catches all HTTP methods, not just GET, to handle any future non-GET routes.
app.use((req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'), {
    headers: { 'Cache-Control': 'no-cache' },
  });
});

app.listen(PORT, () => {
  console.log(`Admin dashboard server running on port ${PORT}`);
});
