// backend/src/modules/credits/credits.controller.ts
import { Response } from 'express';
import { CreditsService } from './credits.service';

export class CreditsController {
  /** GET /api/credits — balance + account summary. */
  static async getBalance(req: any, res: Response) {
    try {
      const account = await CreditsService.getAccount(req.user.id);
      res.json(account);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load ride credits' });
    }
  }

  /** GET /api/credits/transactions — ledger history. */
  static async getTransactions(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const txs = await CreditsService.listTransactions(req.user.id, limit, offset);
      res.json({ transactions: txs });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load credit transactions' });
    }
  }
}
