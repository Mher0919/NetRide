// backend/src/services/email.service.ts
import { google } from 'googleapis';
import { env } from '../config/env';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';

export class EmailService {
  private static oauth2Client = new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );

  private static async getGmailClient() {
    this.oauth2Client.setCredentials({
      refresh_token: env.GMAIL_REFRESH_TOKEN,
    });
    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  /**
   * Internal helper to send emails using Gmail API but with Nodemailer's 
   * easy MIME/Attachment generation.
   */
  private static async sendEmail(options: nodemailer.SendMailOptions): Promise<void> {
    if (!env.GMAIL_USER_EMAIL || !env.GMAIL_REFRESH_TOKEN) {
      console.warn('⚠️ Gmail credentials missing. Email not sent.');
      return;
    }

    try {
      const gmail = await this.getGmailClient();
      
      // Use Nodemailer to generate the raw MIME message string
      const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true,
      });

      const info: any = await transporter.sendMail({
        ...options,
        from: options.from || env.EMAIL_FROM,
      });

      const message = info.message.toString();
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
        },
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Send Error:', error);
      throw error;
    }
  }

  /**
   * Helper to resolve an image URL (data or http) to a CID attachment.
   */
  private static getAttachment(url: string, filename: string, cid: string) {
    if (!url) return null;

    if (url.startsWith('data:')) {
      return {
        filename,
        content: url.split('base64,')[1],
        encoding: 'base64',
        cid
      };
    }

    // If it's an HTTP URL pointing to our server's uploads
    if (url.includes('/uploads/')) {
      const filePart = url.split('/uploads/')[1];
      const filePath = path.join(__dirname, '../../uploads', filePart);
      if (fs.existsSync(filePath)) {
        return {
          filename,
          path: filePath,
          cid
        };
      }
    }

    return null;
  }

  static async sendOTP(email: string, code: string): Promise<void> {
    try {
      await this.sendEmail({
        to: email,
        subject: 'Your Uberish Verification Code',
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #000; text-align: center;">Uberish</h2>
          <p>Hello,</p>
          <p>Your verification code for Uberish is:</p>
          <div style="background-color: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
            ${code}
          </div>
          <p>This code will expire in 10 minutes. If you did not request this code, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #777; text-align: center;">
            &copy; 2026 Uberish. All rights reserved.
          </p>
        </div>
        `,
      });
      console.log(`✅ [GMAIL API] Verification code sent to ${email}`);
    } catch (error) {
      // Logged in sendEmail
    }
  }

  static async sendDriverRegistrationNotice(data: any): Promise<void> {
    try {
      const verifyUrl = `${env.APP_URL}/api/admin/verify-driver/${data.personalInfo.userId}`;
      const attachments: any[] = [];
      
      const profileAtt = this.getAttachment(data.personalInfo.profile_image_url, 'profile.jpg', 'profile_image');
      if (profileAtt) attachments.push(profileAtt);

      const licenseFrontAtt = this.getAttachment(data.identity.license_photo_url, 'license_front.jpg', 'license_front_image');
      if (licenseFrontAtt) attachments.push(licenseFrontAtt);

      const licenseBackAtt = this.getAttachment(data.identity.license_photo_back_url, 'license_back.jpg', 'license_back_image');
      if (licenseBackAtt) attachments.push(licenseBackAtt);

      await this.sendEmail({
        to: env.GMAIL_USER_EMAIL,
        subject: `New Driver Application: ${data.personalInfo.full_name}`,
        attachments,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">New Driver Application</h2>
            <hr>
            <h3>Personal Info</h3>
            <p><strong>Name:</strong> ${data.personalInfo.full_name}</p>
            <p><strong>Email:</strong> ${data.personalInfo.email}</p>
            <p><strong>Phone:</strong> ${data.personalInfo.phone_number}</p>
            <p><strong>DOB:</strong> ${data.personalInfo.date_of_birth}</p>
            ${profileAtt ? '<img src="cid:profile_image" style="width: 150px; height: 150px; border-radius: 75px; object-fit: cover;">' : ''}

            <h3>Identity</h3>
            <p><strong>License #:</strong> ${data.identity.license_number}</p>
            <p><strong>Expiry:</strong> ${data.identity.license_expiry_date}</p>
            <div style="display: flex; gap: 10px;">
              <div style="flex: 1;">
                <p><strong>Front:</strong></p>
                ${licenseFrontAtt ? '<img src="cid:license_front_image" style="max-width: 100%; border-radius: 8px;">' : '<p>(Missing)</p>'}
              </div>
              <div style="flex: 1;">
                <p><strong>Back:</strong></p>
                ${licenseBackAtt ? '<img src="cid:license_back_image" style="max-width: 100%; border-radius: 8px;">' : '<p>(Missing)</p>'}
              </div>
            </div>

            <div style="margin-top: 30px; text-align: center;">
              <a href="${verifyUrl}" style="background-color: #28a745; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">VERIFY DRIVER</a>
            </div>
          </div>
        `,
      });
      console.log(`✅ [GMAIL API] Driver application notice sent to admin`);
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending driver notice:', error);
    }
  }

  static async sendRiderVerificationNotice(user: any, idFrontUrl: string, idBackUrl: string): Promise<void> {
    try {
      const verifyUrl = `${env.APP_URL}/api/admin/verify-rider/${user.id}`;
      const dobFormatted = user.date_of_birth ? new Date(user.date_of_birth).toLocaleDateString('en-US') : 'Not provided';
      
      const attachments: any[] = [];
      const idFrontAtt = this.getAttachment(idFrontUrl, 'id_front.jpg', 'id_front_image');
      if (idFrontAtt) attachments.push(idFrontAtt);

      const idBackAtt = this.getAttachment(idBackUrl, 'id_back.jpg', 'id_back_image');
      if (idBackAtt) attachments.push(idBackAtt);

      await this.sendEmail({
        to: env.GMAIL_USER_EMAIL,
        subject: `Rider Verification Request: ${user.full_name}`,
        attachments,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Rider Verification Request</h2>
            <hr>
            <p><strong>Name:</strong> ${user.full_name}</p>
            <p><strong>Email:</strong> ${user.email}</p>
            <p><strong>Phone:</strong> ${user.phone_number || 'Not provided'}</p>
            <p><strong>Date of Birth:</strong> ${dobFormatted}</p>
            
            <h3>ID Photos</h3>
            <div style="display: flex; gap: 10px;">
              <div style="flex: 1;">
                <p><strong>Front:</strong></p>
                ${idFrontAtt ? '<img src="cid:id_front_image" style="max-width: 100%; border-radius: 8px;">' : '<p>(Missing)</p>'}
              </div>
              <div style="flex: 1;">
                <p><strong>Back:</strong></p>
                ${idBackAtt ? '<img src="cid:id_back_image" style="max-width: 100%; border-radius: 8px;">' : '<p>(Missing)</p>'}
              </div>
            </div>

            <div style="margin-top: 30px; text-align: center;">
              <a href="${verifyUrl}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">VERIFY RIDER</a>
            </div>
          </div>
        `,
      });
      console.log(`✅ [GMAIL API] Rider verification notice sent to admin`);
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending rider notice:', error);
    }
  }

  static async sendPasswordResetLink(email: string, fullName: string, token: string): Promise<void> {
    try {
      const resetUrl = `${env.APP_URL}/api/auth/reset-password?token=${token}`;
      
      await this.sendEmail({
        to: email,
        subject: 'Reset your Uberish Password',
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
          <h2 style="color: #333;">Password Reset</h2>
          <p>Hi ${fullName},</p>
          <p>We received a request to reset your password. Click the button below to choose a new one:</p>
          <div style="margin-top: 30px; text-align: center;">
            <a href="${resetUrl}" style="background-color: #000; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">RESET PASSWORD</a>
          </div>
          <p style="margin-top: 20px; font-size: 12px; color: #777;">If you did not request this, please ignore this email.</p>
        </div>
        `,
      });
      console.log(`✅ [GMAIL API] Password reset link sent to ${email}`);
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending reset link:', error);
    }
  }

  static async sendEmailChangeLink(email: string, fullName: string, token: string): Promise<void> {
    try {
      const verifyUrl = `${env.APP_URL}/api/user/verify-email-change/${token}`;
      
      await this.sendEmail({
        to: email,
        subject: 'Verify your new Uberish Email',
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
          <h2 style="color: #333;">Verify New Email</h2>
          <p>Hi ${fullName},</p>
          <p>Please click the button below to verify your new email address:</p>
          <div style="margin-top: 30px; text-align: center;">
            <a href="${verifyUrl}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">VERIFY EMAIL</a>
          </div>
        </div>
        `,
      });
      console.log(`✅ [GMAIL API] Email change verification sent to ${email}`);
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending email verification:', error);
    }
  }
}
