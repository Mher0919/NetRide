// backend/src/modules/auth/otp.service.ts
import { pool } from '../../config/database';
import { EmailService } from '../../services/email.service';

export class OTPService {
  static async generateOTP(email: string): Promise<string> {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    // Clean up old codes for this email
    await pool.query('DELETE FROM verification_codes WHERE email = $1', [email]);

    // Save new code
    await pool.query(
      'INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, $3)',
      [email, code, expiresAt]
    );

    // Send code via email
    console.log(`\n📧 [VERIFICATION] Code for ${email}: ${code}\n`);
    await EmailService.sendOTP(email, code);
    
    return code;
  }

  static async verifyOTP(email: string, code: string): Promise<boolean> {
    const res = await pool.query(
      'SELECT * FROM verification_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()',
      [email, code]
    );

    if (res.rows.length > 0) {
      // Delete the code after successful verification
      await pool.query('DELETE FROM verification_codes WHERE email = $1', [email]);
      return true;
    }

    return false;
  }
}
