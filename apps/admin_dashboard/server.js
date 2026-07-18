import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5173;

// Serve static files from the Vite build output
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback — any unknown route returns index.html so React Router handles it
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Admin dashboard server running on port ${PORT}`);
});
