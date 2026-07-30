import { Request, Response } from 'express';
import { PlacesService } from './places.service';

export const PlacesController = {
  async search(req: Request, res: Response) {
    try {
      const q = (req.query.q as string || '').trim();
      if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }

      const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
      const lon = req.query.lon ? parseFloat(req.query.lon as string) : undefined;

      const results = await PlacesService.search(q, lat, lon);
      res.json(results);
    } catch (err: any) {
      console.error('[PLACES] Search error:', err.message);
      res.status(500).json({ error: 'Failed to search places' });
    }
  },

  async categories(_req: Request, res: Response) {
    try {
      const categories = await PlacesService.getCategories();
      res.json({ categories });
    } catch (err: any) {
      console.error('[PLACES] Categories error:', err.message);
      res.status(500).json({ error: 'Failed to get categories' });
    }
  },

  async count(_req: Request, res: Response) {
    try {
      const count = await PlacesService.getPlaceCount();
      res.json({ count });
    } catch (err: any) {
      console.error('[PLACES] Count error:', err.message);
      res.status(500).json({ error: 'Failed to get place count' });
    }
  },
};
