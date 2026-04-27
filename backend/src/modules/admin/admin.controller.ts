// backend/src/modules/admin/admin.controller.ts
import { Request, Response } from 'express';
import { pool } from '../../config/database';

export class AdminController {
  static async verifyDriver(req: Request, res: Response) {
    const { userId } = req.params;
    console.log(`🔍 [ADMIN] Attempting to verify driver: ${userId}`);
    try {
      const driverRes = await pool.query(
        'UPDATE drivers SET is_active = true, background_check_status = $1 WHERE user_id = $2 RETURNING *',
        ['APPROVED', userId]
      );
      console.log(`✅ [ADMIN] Driver update result: ${driverRes.rowCount} rows`);
      
      const userRes = await pool.query(
        'UPDATE users SET is_verified = true WHERE id = $1 RETURNING *',
        [userId]
      );
      console.log(`✅ [ADMIN] User update result: ${userRes.rowCount} rows`);

      res.send(`
        <div style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: green;">✅ Driver Verified Successfully!</h1>
          <p>The driver (${userId}) can now start using the Uberish app.</p>
        </div>
      `);
    } catch (error: any) {
      console.error(`❌ [ADMIN] Error verifying driver ${userId}:`, error);
      res.status(500).send(`<h1>Error verifying driver: ${error.message}</h1>`);
    }
  }

  static async verifyRider(req: Request, res: Response) {
    const { userId } = req.params;
    console.log(`🔍 [ADMIN] Attempting to verify rider: ${userId}`);
    try {
      const userRes = await pool.query(
        'UPDATE users SET is_verified = true WHERE id = $1 RETURNING *',
        [userId]
      );
      console.log(`✅ [ADMIN] User update result: ${userRes.rowCount} rows`);

      res.send(`
        <div style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: green;">✅ Rider Verified Successfully!</h1>
          <p>The rider (${userId}) is now marked as verified.</p>
        </div>
      `);
    } catch (error: any) {
      console.error(`❌ [ADMIN] Error verifying rider ${userId}:`, error);
      res.status(500).send(`<h1>Error verifying rider: ${error.message}</h1>`);
    }
  }
}
