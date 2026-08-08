// backend/src/modules/wallet/wallet.controller.ts
import { Response } from 'express';
import { WalletService } from './wallet.service';

export class WalletController {
  /** GET /api/wallet — balance + account summary. */
  static async getBalance(req: any, res: Response) {
    try {
      const account = await WalletService.getAccount(req.user.id);
      res.json(account);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load wallet' });
    }
  }

  /** GET /api/wallet/transactions — ledger history. */
  static async getTransactions(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const txs = await WalletService.listTransactions(req.user.id, limit, offset);
      res.json({ transactions: txs });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load wallet transactions' });
    }
  }

  /** POST /api/wallet/grant — admin grant (or negative adjustment). */
  static async adminGrant(req: any, res: Response) {
    try {
      const { userId, amountCents, reason } = req.body ?? {};
      if (!userId || typeof amountCents !== 'number' || !Number.isFinite(amountCents)) {
        return res.status(400).json({ error: 'userId and amountCents are required' });
      }
      const result = await WalletService.adminGrant(
        req.user.id,
        userId,
        amountCents,
        String(reason ?? ''),
      );
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to grant wallet funds' });
    }
  }
}
