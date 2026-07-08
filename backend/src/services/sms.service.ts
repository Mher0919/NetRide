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

  static async sendVerificationCode(phoneNumber: string) {
    const client = this.getClient();
    if (!client || !env.TWILIO_VERIFY_SERVICE_SID) {
      console.warn('[SMS] ⚠️ Twilio not configured, skipping SMS send.');
      return { status: 'skipped', message: 'SMS verification skipped (not configured)' };
    }

    try {
      const verification = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to: phoneNumber, channel: 'sms' });
      
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

    try {
      const verificationCheck = await client.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: phoneNumber, code });
      
      return { status: verificationCheck.status };
    } catch (error: any) {
      console.error('[SMS] ❌ Error verifying code:', error.message);
      throw new Error(`Failed to verify code: ${error.message}`);
    }
  }
}
