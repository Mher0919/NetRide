// backend/src/services/sms.service.ts
import twilio from 'twilio';
import { env } from '../config/env';

export class SmsService {
  private static client?: twilio.Twilio;

  private static getClient() {
    if (!this.client && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      this.client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    }
    return this.client;
  }

  // Twilio Verify requires E.164 formatting (e.g. +17477245408). Clients may
  // send a raw 10-digit US number, so normalize defensively here rather than
  // trusting the frontend. Returns null if the number cannot be coerced.
  private static toE164(phoneNumber: string): string | null {
    let digits = phoneNumber.replace(/\D/g, '');
    if (digits.length === 10) {
      // Assume US/Canada when exactly 10 digits are supplied.
      digits = '1' + digits;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      return '+' + digits;
    }
    if (phoneNumber.startsWith('+') && digits.length >= 11) {
      return '+' + digits;
    }
    return null;
  }

  static async sendVerificationCode(phoneNumber: string) {
    const client = this.getClient();
    if (!client || !env.TWILIO_VERIFY_SERVICE_SID) {
      console.warn('[SMS] ⚠️ Twilio not configured, skipping SMS send.');
      return { status: 'skipped', message: 'SMS verification skipped (not configured)' };
    }

    const e164 = this.toE164(phoneNumber);
    if (!e164) {
      throw new Error('Invalid phone number format.');
    }

    try {
      const verification = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to: e164, channel: 'sms' });
      
      return { status: verification.status };
    } catch (error: any) {
      console.error('[SMS] ❌ Error sending verification code:', error.message);
      throw new Error(`Failed to send verification code: ${error.message}`);
    }
  }

  static async verifyCode(phoneNumber: string, code: string) {
    const client = this.getClient();
    if (!client || !env.TWILIO_VERIFY_SERVICE_SID) {
      console.warn('[SMS] ⚠️ Twilio not configured, auto-verifying for development.');
      return { status: 'approved' };
    }

    const e164 = this.toE164(phoneNumber);
    if (!e164) {
      throw new Error('Invalid phone number format.');
    }

    try {
      const verificationCheck = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: e164, code });
      
      return { status: verificationCheck.status };
    } catch (error: any) {
      console.error('[SMS] ❌ Error verifying code:', error.message);
      throw new Error(`Failed to verify code: ${error.message}`);
    }
  }
}
