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

  private static DOC_TYPE_LABELS: Record<string, string> = {
    license_photo_url: 'Driver License (Front)',
    license_photo_back_url: 'Driver License (Back)',
    insurance_photo_url: 'Insurance Certificate',
    registration_photo_url: 'Vehicle Registration',
    inspection_photo_url: 'Vehicle Inspection',
    id_photo_front_url: 'ID Card (Front)',
    id_photo_back_url: 'ID Card (Back)',
  };

  private static formatDocTypes(types: string[]): string {
    return types.map(t => this.DOC_TYPE_LABELS[t] || t).join(', ');
  }

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
    if (!env.GMAIL_USER_EMAIL || !env.GMAIL_REFRESH_TOKEN || !env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
      console.error('❌ [GMAIL API] Cannot send email. Gmail credentials (USER_EMAIL, REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET) are missing in .env.');
      throw new Error('Email service not configured. Please check backend .env file.');
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
      console.log(`✅ [GMAIL API] Email sent successfully to ${options.to}`);
    } catch (error: any) {
      console.error('❌ [GMAIL API] Send Error:', error.message);
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

  static async sendPasswordChangeVerification(email: string, fullName: string, token: string): Promise<void> {
    try {
      const verifyUrl = `io.supabase.netride://password-reset?token=${token}`;
      
      await this.sendEmail({
        to: email,
        subject: 'Verify Password Change',
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
          <h2 style="color: #333;">Security Verification</h2>
          <p>Hi ${fullName},</p>
          <p>We received a request to change your NetRide password. Is this you?</p>
          <div style="margin-top: 30px; text-align: center;">
            <a href="${verifyUrl}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">YES, CHANGE PASSWORD</a>
          </div>
          <p style="margin-top: 20px; font-size: 12px; color: #777;">If you did not request this, please ignore this email and your password will remain unchanged.</p>
        </div>
        `,
      });
      console.log(`✅ [GMAIL API] Password change verification sent to ${email}`);
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending password change verification:', error);
    }
  }

  static async sendOTP(email: string, code: string): Promise<void> {
    try {
      await this.sendEmail({
        to: email,
        subject: 'Your NetRide Verification Code',
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #000; text-align: center;">NetRide</h2>
          <p>Hello,</p>
          <p>Your verification code for NetRide is:</p>
          <div style="background-color: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
            ${code}
          </div>
          <p>This code will expire in 10 minutes. If you did not request this code, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #777; text-align: center;">
            &copy; 2026 NetRide. All rights reserved.
          </p>
        </div>
        `,
      });
    } catch (error) {
      // Error is already logged in sendEmail
    }
  }

  static async sendDriverRegistrationNotice(data: any): Promise<void> {
    try {
      const verifyUrl = `${env.ADMIN_URL}/users/${data.personalInfo.userId}`;
      
      await this.sendEmail({
        to: env.GMAIL_USER_EMAIL,
        subject: `New Driver Application: ${data.personalInfo.full_name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">New Driver Application</h2>
            <hr>
            <p>A new driver application has been submitted and is pending verification.</p>
            <p><strong>Applicant:</strong> ${data.personalInfo.full_name}</p>
            <p><strong>Email:</strong> ${data.personalInfo.email}</p>
            
            <p style="margin-top: 20px;">Please log in to the Admin Dashboard to review the documents and verify the driver.</p>

            <div style="margin-top: 30px; text-align: center;">
              <a href="${verifyUrl}" style="background-color: #28a745; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">REVIEW APPLICATION</a>
            </div>
            
            <p style="margin-top: 30px; font-size: 12px; color: #777; text-align: center;">
              For security reasons, full application details and document photos are only available within the secure Admin Dashboard.
            </p>
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
      const verifyUrl = `${env.ADMIN_URL}/users/${user.id}`;
      
      await this.sendEmail({
        to: env.GMAIL_USER_EMAIL,
        subject: `Rider Verification Request: ${user.full_name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Rider Verification Request</h2>
            <hr>
            <p>A rider has requested identity verification.</p>
            <p><strong>Rider:</strong> ${user.full_name}</p>
            <p><strong>Email:</strong> ${user.email}</p>
            
            <p style="margin-top: 20px;">Please log in to the Admin Dashboard to review the ID photos and verify the rider.</p>

            <div style="margin-top: 30px; text-align: center;">
              <a href="${verifyUrl}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">REVIEW REQUEST</a>
            </div>

            <p style="margin-top: 30px; font-size: 12px; color: #777; text-align: center;">
              For security reasons, ID photos and personal details are only available within the secure Admin Dashboard.
            </p>
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
        subject: 'Reset your NetRide Password',
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
        subject: 'Verify your new NetRide Email',
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

  // ============================================================
  // Profile-change approval emails (020)
  // ============================================================

  static async sendProfileChangeNotice(admin: { email?: string }, driver: { id: string; email?: string; full_name?: string }, request: { id: string; requested_changes: any; card_last4?: string | null; card_brand?: string | null }) {
    if (!admin.email) return;
    try {
      const reviewUrl = `${env.ADMIN_URL}/profile-changes/${request.id}`;
      const cardLine = request.card_last4
        ? `<p><strong>Payout card queued:</strong> ${request.card_brand?.toUpperCase() ?? 'Card'} ending in ${request.card_last4}</p>`
        : '';
      const fieldsLine = Object.keys(request.requested_changes || {})
        .filter(k => k !== 'payout_card_id')
        .map(k => `<li>${k}</li>`).join('');
      await this.sendEmail({
        to: admin.email,
        subject: `Profile change request — ${driver.full_name ?? 'Driver'}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Profile change awaiting review</h2>
            <p>Driver <strong>${driver.full_name ?? 'Unknown'}</strong> (${driver.email ?? ''}) has submitted a profile change.</p>
            <p><strong>Requested fields:</strong></p>
            <ul>${fieldsLine}</ul>
            ${cardLine}
            <div style="margin-top: 24px; text-align: center;">
              <a href="${reviewUrl}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">REVIEW REQUEST</a>
            </div>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending profile-change admin notice:', error);
    }
  }

  static async sendProfileChangeSubmittedEmail(driver: { email?: string; full_name?: string }, request: { id: string; requested_changes: any; card_last4?: string | null; card_brand?: string | null }) {
    if (!driver.email) return;
    try {
      const fieldsLine = Object.keys(request.requested_changes || {})
        .filter(k => k !== 'payout_card_id')
        .map(k => `<li>${k}</li>`).join('');
      await this.sendEmail({
        to: driver.email,
        subject: "We've received your profile changes",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Your changes are under review</h2>
            <p>Hi ${driver.full_name ?? 'Driver'},</p>
            <p>We've received your profile changes and our team will review them shortly. While your request is being reviewed, you will not be able to go online. We'll notify you by email and in-app when the review is complete.</p>
            <p><strong>Requested fields:</strong></p>
            <ul>${fieldsLine}</ul>
            <p style="color: #888; font-size: 12px;">Reference: ${request.id}</p>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending profile-change submitted email:', error);
    }
  }

  static async sendProfileChangeApprovedEmail(driver: { email?: string; full_name?: string }) {
    if (!driver.email) return;
    try {
      await this.sendEmail({
        to: driver.email,
        subject: 'Your profile changes are live',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #5B7760;">All set — you're cleared to drive again</h2>
            <p>Hi ${driver.full_name ?? 'Driver'},</p>
            <p>Great news — your recent profile changes have been approved and are now live. You can go online and start driving again whenever you're ready.</p>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending profile-change approved email:', error);
    }
  }

  static async sendProfileChangeRejectedEmail(driver: { email?: string; full_name?: string }, reason: string) {
    if (!driver.email) return;
    try {
      await this.sendEmail({
        to: driver.email,
        subject: 'Your profile changes need a revision',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #C65A5A;">Update needed</h2>
            <p>Hi ${driver.full_name ?? 'Driver'},</p>
            <p>Unfortunately your recent profile changes couldn't be approved as submitted. The good news: you're still cleared to drive. Please review the note below, make the suggested adjustments, and submit a new change request when you're ready.</p>
            <div style="margin: 16px 0; padding: 14px; border-left: 4px solid #C65A5A; background: #f9f4f4;">
              <strong>Reviewer note:</strong> ${reason}
            </div>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending profile-change rejected email:', error);
    }
  }

  // ============================================================
  // Document resubmission emails (024)
  // ============================================================

  static async sendDocumentResubmissionRequestedEmail(driver: { email?: string; full_name?: string }, info: { document_type: string; reason: string }) {
    if (!driver.email) return;
    const label = this.DOC_TYPE_LABELS[info.document_type] || info.document_type;
    try {
      await this.sendEmail({
        to: driver.email,
        subject: `Action Required — Update your ${label}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #C65A5A;">Document update needed</h2>
            <p>Hi ${driver.full_name ?? 'Driver'},</p>
            <p>Our team has reviewed your documents and needs an updated version of <strong>${label}</strong>.</p>
            <div style="margin: 16px 0; padding: 14px; border-left: 4px solid #C65A5A; background: #f9f4f4;">
              <strong>Reason:</strong> ${info.reason}
            </div>
            <p>Please open the app, go to your profile, and resubmit the requested document. Once you do, our team will review it promptly.</p>
            <p style="color: #888; font-size: 12px;">You won't be able to go online until this is resolved.</p>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending document resubmission email:', error);
    }
  }

  static async sendDocumentResubmissionReviewedEmail(driver: { email?: string; full_name?: string }, info: { document_type: string; decision: string }) {
    if (!driver.email) return;
    const label = this.DOC_TYPE_LABELS[info.document_type] || info.document_type;
    try {
      if (info.decision === 'approved') {
        await this.sendEmail({
          to: driver.email,
          subject: `Your ${label} has been approved`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
              <h2 style="color: #5B7760;">Document approved</h2>
              <p>Hi ${driver.full_name ?? 'Driver'},</p>
              <p>Your updated <strong>${label}</strong> has been reviewed and approved. All documents are in order.</p>
            </div>
          `,
        });
      } else {
        await this.sendEmail({
          to: driver.email,
          subject: `Action Required — Your ${label} needs revision`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
              <h2 style="color: #C65A5A;">Document needs revision</h2>
              <p>Hi ${driver.full_name ?? 'Driver'},</p>
              <p>Unfortunately your updated <strong>${label}</strong> could not be approved. Please open the app and resubmit with a clearer photo.</p>
            </div>
          `,
        });
      }
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending document review email:', error);
    }
  }

  // ============================================================
  // Driver document resubmitted — driver confirmation
  // ============================================================

  static async sendDriverDocumentResubmittedConfirmationEmail(driver: { email?: string; full_name?: string }, info: { document_types: string[] }) {
    if (!driver.email) return;
    const docLabel = this.formatDocTypes(info.document_types);
    try {
      await this.sendEmail({
        to: driver.email,
        subject: 'Your documents have been received',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #5B7760;">Documents received</h2>
            <p>Hi ${driver.full_name ?? 'Driver'},</p>
            <p>Thank you. Your updated documents have been received successfully:</p>
            <p><strong>${docLabel}</strong></p>
            <p>Our team is reviewing your documents now. We'll notify you once the review is complete or if we need any additional information.</p>
            <p style="color: #888; font-size: 12px;">You don't need to do anything else at this time.</p>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending document confirmation email:', error);
    }
  }

  // ============================================================
  // Driver document resubmitted — admin notification
  // ============================================================

  static async sendAdminDocumentResubmissionNoticeEmail(admin: { email?: string }, driver: { id: string; full_name?: string; email?: string }, info: { document_types: string[]; submitted_at: Date }) {
    if (!admin.email) return;
    const docLabel = this.formatDocTypes(info.document_types);
    const reviewUrl = `${env.ADMIN_URL}/users/${driver.id}`;
    try {
      await this.sendEmail({
        to: admin.email,
        subject: `Document review needed — ${driver.full_name ?? 'Driver'}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Documents awaiting review</h2>
            <p>Driver <strong>${driver.full_name ?? 'Unknown'}</strong> (${driver.email ?? ''}) has submitted documents for review.</p>
            <p><strong>Documents submitted:</strong> ${docLabel}</p>
            <p><strong>Submitted at:</strong> ${info.submitted_at.toLocaleString()}</p>
            <p><strong>Status:</strong> Pending Review</p>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${reviewUrl}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">REVIEW DRIVER</a>
            </div>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending admin document notice:', error);
    }
  }

  // ============================================================
  // Payout-card + payout emails (020)
  // ============================================================

  static async sendPayoutCardNotice(admin: { email?: string }, driver: { id: string; email?: string; full_name?: string }, card: { id: string; brand: string; last4: string }) {
    if (!admin.email) return;
    try {
      const url = `${env.ADMIN_URL}/payout-cards`;
      await this.sendEmail({
        to: admin.email,
        subject: `Payout card added — ${driver.full_name ?? 'Driver'}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Payout card awaiting review</h2>
            <p>Driver <strong>${driver.full_name ?? 'Unknown'}</strong> (${driver.email ?? ''}) added a new payout card.</p>
            <p><strong>Card:</strong> ${card.brand.toUpperCase()} ending in ${card.last4}</p>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${url}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">REVIEW CARDS</a>
            </div>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending payout-card notice:', error);
    }
  }

  static async sendPayoutRequestedNotice(admin: { email?: string }, driver: { id: string; email?: string; full_name?: string }, payout: { id: string; amount_cents: number; fee_cents: number; net_cents: number; method: string }) {
    if (!admin.email) return;
    try {
      const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
      const url = `${env.ADMIN_URL}/payouts`;
      await this.sendEmail({
        to: admin.email,
        subject: `Payout requested — ${dollars(payout.net_cents)} to ${driver.full_name ?? 'Driver'}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">On-demand payout awaiting processing</h2>
            <p>Driver <strong>${driver.full_name ?? 'Unknown'}</strong> (${driver.email ?? ''}) requested a payout.</p>
            <p>
              Amount: <strong>${dollars(payout.amount_cents)}</strong><br/>
              Fee (5%): ${dollars(payout.fee_cents)}<br/>
              Net: <strong>${dollars(payout.net_cents)}</strong><br/>
              Method: ${payout.method}
            </p>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${url}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">PROCESS PAYOUT</a>
            </div>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending payout-requested notice:', error);
    }
  }

  static async sendPayoutReceiptEmail(driver: { email?: string; full_name?: string }, payout: { id: string; amount_cents: number; fee_cents: number; net_cents: number; reference?: string | null }) {
    if (!driver.email) return;
    try {
      const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
      await this.sendEmail({
        to: driver.email,
        subject: 'Your payout has been sent',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #5B7760;">Payout sent</h2>
            <p>Hi ${driver.full_name ?? 'Driver'},</p>
            <p>Your recent payout has been processed.</p>
            <p>
              Net amount: <strong>${dollars(payout.net_cents)}</strong><br/>
              ${payout.reference ? `Reference: ${payout.reference}<br/>` : ''}
            </p>
            <p style="color: #888; font-size: 12px;">If you don't see the funds in 1–3 business days, please reply to this email.</p>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending payout receipt email:', error);
    }
  }

  /**
   * Notify all admin users that a driver's face check was flagged for review.
   * `admins` is a list of { email } rows (ADMIN role). Silently skips if no
   * Gmail credentials are configured.
   */
  static async sendFaceCheckFlaggedNotice(
    admins: { email?: string }[],
    info: { driverName?: string; driverEmail?: string; reason?: string; score?: number; eventId?: string },
  ) {
    const recipients = admins.map((a) => a.email).filter(Boolean) as string[];
    if (recipients.length === 0) return;
    try {
      const reasonLabel = info.reason ?? 'unknown';
      await this.sendEmail({
        to: recipients.join(','),
        subject: '⚠️ Driver face check flagged for review',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #C65A5A;">Face check flagged</h2>
            <p>A driver's identity verification failed automated checks and needs manual review.</p>
            <p>
              Driver: <strong>${info.driverName ?? 'Unknown'}</strong> (${info.driverEmail ?? 'n/a'})<br/>
              Reason: <strong>${reasonLabel}</strong><br/>
              Score: ${info.score ?? 'n/a'}<br/>
              Event ID: ${info.eventId ?? 'n/a'}
            </p>
            <p style="color: #888; font-size: 12px;">Review it in the Admin Dashboard → Face Checks.</p>
          </div>
        `,
      });
    } catch (error) {
      console.error('❌ [GMAIL API] Error sending face-check flagged notice:', error);
    }
  }
}

