import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5174;
const DIST_DIR = path.join(__dirname, 'dist');

app.use(express.static(DIST_DIR, {
  maxAge: '1y',
  immutable: true,
}));

// SPA fallback — any unknown path returns index.html.
app.use((req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'), {
    headers: { 'Cache-Control': 'no-cache' },
  });
});

app.listen(PORT, () => {
  console.log(`NetRide partner portal running on port ${PORT}`);
});