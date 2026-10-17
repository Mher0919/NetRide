"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailService = exports.encodeUrlPart = exports.escapeHtml = void 0;
// backend/src/services/email.service.ts
const googleapis_1 = require("googleapis");
const env_1 = require("../config/env");
const nodemailer_1 = __importDefault(require("nodemailer"));
const html_escape_1 = require("../utils/html-escape");
Object.defineProperty(exports, "escapeHtml", { enumerable: true, get: function () { return html_escape_1.escapeHtml; } });
Object.defineProperty(exports, "encodeUrlPart", { enumerable: true, get: function () { return html_escape_1.encodeUrlPart; } });
class EmailService {
    static formatDocTypes(types) {
        return types.map(t => this.DOC_TYPE_LABELS[t] || t).join(', ');
    }
    static async getGmailClient() {
        this.oauth2Client.setCredentials({
            refresh_token: env_1.env.GMAIL_REFRESH_TOKEN,
        });
        return googleapis_1.google.gmail({ version: 'v1', auth: this.oauth2Client });
    }
    /**
     * Internal helper to send emails using Gmail API but with Nodemailer's
     * easy MIME/Attachment generation.
     */
    static async sendEmail(options) {
        if (!env_1.env.GMAIL_USER_EMAIL || !env_1.env.GMAIL_REFRESH_TOKEN || !env_1.env.GMAIL_CLIENT_ID || !env_1.env.GMAIL_CLIENT_SECRET) {
            console.error('❌ [GMAIL API] Cannot send email. Gmail credentials (USER_EMAIL, REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET) are missing in .env.');
            throw new Error('Email service not configured. Please check backend .env file.');
        }
        const fromAddress = (env_1.env.EMAIL_FROM.match(/<([^>]+)>/) ?? [null, env_1.env.EMAIL_FROM])[1]?.trim();
        if (fromAddress && fromAddress.toLowerCase() !== env_1.env.GMAIL_USER_EMAIL.toLowerCase()) {
            // Gmail rewrites the From header to the authenticated account unless
            // the EMAIL_FROM address is a verified "Send mail as" alias there.
            // Log loudly so a wrong-looking sender is never a silent surprise.
            console.warn(`⚠️ [GMAIL API] Sending as "${env_1.env.EMAIL_FROM}" but authenticated as ${env_1.env.GMAIL_USER_EMAIL}. ` +
                `Gmail will show the authenticated account as sender unless "${fromAddress}" is added as a ` +
                `verified "Send mail as" alias in ${env_1.env.GMAIL_USER_EMAIL} (Gmail Settings → Accounts and Import).`);
        }
        try {
            const gmail = await this.getGmailClient();
            // Use Nodemailer to generate the raw MIME message string
            const transporter = nodemailer_1.default.createTransport({
                streamTransport: true,
                newline: 'unix',
                buffer: true,
            });
            const info = await transporter.sendMail({
                ...options,
                from: options.from || env_1.env.EMAIL_FROM,
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
        }
        catch (error) {
            // Log only the message: the full GaxiosError can embed the request
            // config (Authorization header) and request body (OTP codes / links).
            console.error('❌ [GMAIL API] Send Error:', error?.message);
            throw error;
        }
    }
    static async sendPasswordChangeVerification(email, fullName, token) {
        try {
            const verifyUrl = `io.supabase.netride://password-reset?token=${(0, html_escape_1.encodeUrlPart)(token)}`;
            const safeName = (0, html_escape_1.escapeHtml)(fullName);
            await this.sendEmail({
                to: email,
                subject: 'Verify Password Change',
                html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
          <h2 style="color: #333;">Security Verification</h2>
          <p>Hi ${safeName},</p>
          <p>We received a request to change your NetRide password. Is this you?</p>
          <div style="margin-top: 30px; text-align: center;">
            <a href="${(0, html_escape_1.escapeHtml)(verifyUrl)}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">YES, CHANGE PASSWORD</a>
          </div>
          <p style="margin-top: 20px; font-size: 12px; color: #777;">If you did not request this, please ignore this email and your password will remain unchanged.</p>
        </div>
        `,
            });
            console.log(`✅ [GMAIL API] Password change verification sent to ${email}`);
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending password change verification:', error?.message);
        }
    }
    static async sendOTP(email, code) {
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
            ${(0, html_escape_1.escapeHtml)(code)}
          </div>
          <p>This code will expire in 10 minutes. If you did not request this code, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #777; text-align: center;">
            &copy; 2026 NetRide. All rights reserved.
          </p>
        </div>
        `,
            });
        }
        catch (error) {
            // Error is already logged in sendEmail
        }
    }
    static async sendDriverRegistrationNotice(data) {
        try {
            const verifyUrl = `${env_1.env.ADMIN_URL}/users/${(0, html_escape_1.encodeUrlPart)(data.personalInfo.userId)}`;
            const safeName = (0, html_escape_1.escapeHtml)(data.personalInfo.full_name);
            await this.sendEmail({
                to: env_1.env.ADMIN_NOTIFY_EMAIL,
                subject: `New Driver Application: ${data.personalInfo.full_name}`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">New Driver Application</h2>
            <hr>
            <p>A new driver application has been submitted and is pending verification.</p>
            <p><strong>Applicant:</strong> ${safeName}</p>
            <p><strong>Email:</strong> ${(0, html_escape_1.escapeHtml)(data.personalInfo.email)}</p>
            
            <p style="margin-top: 20px;">Please log in to the Admin Dashboard to review the documents and verify the driver.</p>

            <div style="margin-top: 30px; text-align: center;">
              <a href="${(0, html_escape_1.escapeHtml)(verifyUrl)}" style="background-color: #28a745; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">REVIEW APPLICATION</a>
            </div>
            
            <p style="margin-top: 30px; font-size: 12px; color: #777; text-align: center;">
              For security reasons, full application details and document photos are only available within the secure Admin Dashboard.
            </p>
          </div>
        `,
            });
            console.log(`✅ [GMAIL API] Driver application notice sent to admin`);
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending driver notice:', error?.message);
        }
    }
    static async sendRiderVerificationNotice(user, idFrontUrl, idBackUrl) {
        try {
            const verifyUrl = `${env_1.env.ADMIN_URL}/users/${(0, html_escape_1.encodeUrlPart)(user.id)}`;
            const safeName = (0, html_escape_1.escapeHtml)(user.full_name);
            await this.sendEmail({
                to: env_1.env.ADMIN_NOTIFY_EMAIL,
                subject: `Rider Verification Request: ${user.full_name}`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Rider Verification Request</h2>
            <hr>
            <p>A rider has requested identity verification.</p>
            <p><strong>Rider:</strong> ${safeName}</p>
            <p><strong>Email:</strong> ${(0, html_escape_1.escapeHtml)(user.email)}</p>
            
            <p style="margin-top: 20px;">Please log in to the Admin Dashboard to review the ID photos and verify the rider.</p>

            <div style="margin-top: 30px; text-align: center;">
              <a href="${(0, html_escape_1.escapeHtml)(verifyUrl)}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 18px;">REVIEW REQUEST</a>
            </div>

            <p style="margin-top: 30px; font-size: 12px; color: #777; text-align: center;">
              For security reasons, ID photos and personal details are only available within the secure Admin Dashboard.
            </p>
          </div>
        `,
            });
            console.log(`✅ [GMAIL API] Rider verification notice sent to admin`);
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending rider notice:', error?.message);
        }
    }
    static async sendPasswordResetLink(email, fullName, token) {
        try {
            const resetUrl = `${env_1.env.APP_URL}/api/auth/reset-password?token=${(0, html_escape_1.encodeUrlPart)(token)}`;
            const safeName = (0, html_escape_1.escapeHtml)(fullName);
            await this.sendEmail({
                to: email,
                subject: 'Reset your NetRide Password',
                html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
          <h2 style="color: #333;">Password Reset</h2>
          <p>Hi ${safeName},</p>
          <p>We received a request to reset your password. Click the button below to choose a new one:</p>
          <div style="margin-top: 30px; text-align: center;">
            <a href="${(0, html_escape_1.escapeHtml)(resetUrl)}" style="background-color: #000; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">RESET PASSWORD</a>
          </div>
          <p style="margin-top: 20px; font-size: 12px; color: #777;">If you did not request this, please ignore this email.</p>
        </div>
        `,
            });
            console.log(`✅ [GMAIL API] Password reset link sent to ${email}`);
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending reset link:', error?.message);
        }
    }
    static async sendEmailChangeLink(email, fullName, token) {
        try {
            const verifyUrl = `${env_1.env.APP_URL}/api/user/verify-email-change/${(0, html_escape_1.encodeUrlPart)(token)}`;
            const safeName = (0, html_escape_1.escapeHtml)(fullName);
            await this.sendEmail({
                to: email,
                subject: 'Verify your new NetRide Email',
                html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
          <h2 style="color: #333;">Verify New Email</h2>
          <p>Hi ${safeName},</p>
          <p>Please click the button below to verify your new email address:</p>
          <div style="margin-top: 30px; text-align: center;">
            <a href="${(0, html_escape_1.escapeHtml)(verifyUrl)}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">VERIFY EMAIL</a>
          </div>
        </div>
        `,
            });
            console.log(`✅ [GMAIL API] Email change verification sent to ${email}`);
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending email verification:', error?.message);
        }
    }
    // ============================================================
    // Profile-change approval emails (020)
    // ============================================================
    static async sendProfileChangeNotice(admin, driver, request) {
        if (!admin.email)
            return;
        try {
            const reviewUrl = `${env_1.env.ADMIN_URL}/profile-changes/${(0, html_escape_1.encodeUrlPart)(request.id)}`;
            const safeBrand = (0, html_escape_1.escapeHtml)(request.card_brand?.toUpperCase() ?? 'Card');
            const safeLast4 = (0, html_escape_1.escapeHtml)(request.card_last4);
            const cardLine = request.card_last4
                ? `<p><strong>Payout card queued:</strong> ${safeBrand} ending in ${safeLast4}</p>`
                : '';
            const fieldsLine = Object.keys(request.requested_changes || {})
                .filter(k => k !== 'payout_card_id')
                .map(k => `<li>${(0, html_escape_1.escapeHtml)(k)}</li>`).join('');
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Unknown');
            const safeEmail = (0, html_escape_1.escapeHtml)(driver.email ?? '');
            await this.sendEmail({
                to: admin.email,
                subject: `Profile change request — ${driver.full_name ?? 'Driver'}`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Profile change awaiting review</h2>
            <p>Driver <strong>${safeName}</strong> (${safeEmail}) has submitted a profile change.</p>
            <p><strong>Requested fields:</strong></p>
            <ul>${fieldsLine}</ul>
            ${cardLine}
            <div style="margin-top: 24px; text-align: center;">
              <a href="${(0, html_escape_1.escapeHtml)(reviewUrl)}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">REVIEW REQUEST</a>
            </div>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending profile-change admin notice:', error?.message);
        }
    }
    static async sendProfileChangeSubmittedEmail(driver, request) {
        if (!driver.email)
            return;
        try {
            const fieldsLine = Object.keys(request.requested_changes || {})
                .filter(k => k !== 'payout_card_id')
                .map(k => `<li>${(0, html_escape_1.escapeHtml)(k)}</li>`).join('');
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Driver');
            await this.sendEmail({
                to: driver.email,
                subject: "We've received your profile changes",
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Your changes are under review</h2>
            <p>Hi ${safeName},</p>
            <p>We've received your profile changes and our team will review them shortly. While your request is being reviewed, you will not be able to go online. We'll notify you by email and in-app when the review is complete.</p>
            <p><strong>Requested fields:</strong></p>
            <ul>${fieldsLine}</ul>
            <p style="color: #888; font-size: 12px;">Reference: ${(0, html_escape_1.escapeHtml)(request.id)}</p>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending profile-change submitted email:', error?.message);
        }
    }
    static async sendProfileChangeApprovedEmail(driver) {
        if (!driver.email)
            return;
        try {
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Driver');
            await this.sendEmail({
                to: driver.email,
                subject: 'Your profile changes are live',
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #5B7760;">All set — you're cleared to drive again</h2>
            <p>Hi ${safeName},</p>
            <p>Great news — your recent profile changes have been approved and are now live. You can go online and start driving again whenever you're ready.</p>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending profile-change approved email:', error?.message);
        }
    }
    static async sendProfileChangeRejectedEmail(driver, reason) {
        if (!driver.email)
            return;
        try {
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Driver');
            await this.sendEmail({
                to: driver.email,
                subject: 'Your profile changes need a revision',
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #C65A5A;">Update needed</h2>
            <p>Hi ${safeName},</p>
            <p>Unfortunately your recent profile changes couldn't be approved as submitted. The good news: you're still cleared to drive. Please review the note below, make the suggested adjustments, and submit a new change request when you're ready.</p>
            <div style="margin: 16px 0; padding: 14px; border-left: 4px solid #C65A5A; background: #f9f4f4;">
              <strong>Reviewer note:</strong> ${(0, html_escape_1.escapeHtml)(reason)}
            </div>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending profile-change rejected email:', error?.message);
        }
    }
    // ============================================================
    // Document resubmission emails (024)
    // ============================================================
    static async sendDocumentResubmissionRequestedEmail(driver, info) {
        if (!driver.email)
            return;
        const label = this.DOC_TYPE_LABELS[info.document_type] || info.document_type;
        try {
            const safeLabel = (0, html_escape_1.escapeHtml)(label);
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Driver');
            await this.sendEmail({
                to: driver.email,
                subject: `Action Required — Update your ${label}`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #C65A5A;">Document update needed</h2>
            <p>Hi ${safeName},</p>
            <p>Our team has reviewed your documents and needs an updated version of <strong>${safeLabel}</strong>.</p>
            <div style="margin: 16px 0; padding: 14px; border-left: 4px solid #C65A5A; background: #f9f4f4;">
              <strong>Reason:</strong> ${(0, html_escape_1.escapeHtml)(info.reason)}
            </div>
            <p>Please open the app, go to your profile, and resubmit the requested document. Once you do, our team will review it promptly.</p>
            <p style="color: #888; font-size: 12px;">You won't be able to go online until this is resolved.</p>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending document resubmission email:', error?.message);
        }
    }
    static async sendDocumentResubmissionReviewedEmail(driver, info) {
        if (!driver.email)
            return;
        const label = this.DOC_TYPE_LABELS[info.document_type] || info.document_type;
        try {
            const safeLabel = (0, html_escape_1.escapeHtml)(label);
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Driver');
            if (info.decision === 'approved') {
                await this.sendEmail({
                    to: driver.email,
                    subject: `Your ${label} has been approved`,
                    html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
              <h2 style="color: #5B7760;">Document approved</h2>
              <p>Hi ${safeName},</p>
              <p>Your updated <strong>${safeLabel}</strong> has been reviewed and approved. All documents are in order.</p>
            </div>
          `,
                });
            }
            else {
                await this.sendEmail({
                    to: driver.email,
                    subject: `Action Required — Your ${label} needs revision`,
                    html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
              <h2 style="color: #C65A5A;">Document needs revision</h2>
              <p>Hi ${safeName},</p>
              <p>Unfortunately your updated <strong>${safeLabel}</strong> could not be approved. Please open the app and resubmit with a clearer photo.</p>
            </div>
          `,
                });
            }
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending document review email:', error?.message);
        }
    }
    // ============================================================
    // Driver document resubmitted — driver confirmation
    // ============================================================
    static async sendDriverDocumentResubmittedConfirmationEmail(driver, info) {
        if (!driver.email)
            return;
        const docLabel = this.formatDocTypes(info.document_types);
        try {
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Driver');
            await this.sendEmail({
                to: driver.email,
                subject: 'Your documents have been received',
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #5B7760;">Documents received</h2>
            <p>Hi ${safeName},</p>
            <p>Thank you. Your updated documents have been received successfully:</p>
            <p><strong>${(0, html_escape_1.escapeHtml)(docLabel)}</strong></p>
            <p>Our team is reviewing your documents now. We'll notify you once the review is complete or if we need any additional information.</p>
            <p style="color: #888; font-size: 12px;">You don't need to do anything else at this time.</p>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending document confirmation email:', error?.message);
        }
    }
    // ============================================================
    // Driver document resubmitted — admin notification
    // ============================================================
    static async sendAdminDocumentResubmissionNoticeEmail(admin, driver, info) {
        if (!admin.email)
            return;
        const docLabel = this.formatDocTypes(info.document_types);
        const reviewUrl = `${env_1.env.ADMIN_URL}/users/${(0, html_escape_1.encodeUrlPart)(driver.id)}`;
        try {
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Unknown');
            const safeEmail = (0, html_escape_1.escapeHtml)(driver.email ?? '');
            await this.sendEmail({
                to: admin.email,
                subject: `Document review needed — ${driver.full_name ?? 'Driver'}`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Documents awaiting review</h2>
            <p>Driver <strong>${safeName}</strong> (${safeEmail}) has submitted documents for review.</p>
            <p><strong>Documents submitted:</strong> ${(0, html_escape_1.escapeHtml)(docLabel)}</p>
            <p><strong>Submitted at:</strong> ${(0, html_escape_1.escapeHtml)(info.submitted_at.toLocaleString())}</p>
            <p><strong>Status:</strong> Pending Review</p>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${(0, html_escape_1.escapeHtml)(reviewUrl)}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">REVIEW DRIVER</a>
            </div>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending admin document notice:', error?.message);
        }
    }
    // ============================================================
    // Payout-card + payout emails (020)
    // ============================================================
    static async sendPayoutCardNotice(admin, driver, card) {
        if (!admin.email)
            return;
        try {
            const url = `${env_1.env.ADMIN_URL}/payout-cards`;
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Unknown');
            const safeEmail = (0, html_escape_1.escapeHtml)(driver.email ?? '');
            await this.sendEmail({
                to: admin.email,
                subject: `Payout card added — ${driver.full_name ?? 'Driver'}`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">Payout card awaiting review</h2>
            <p>Driver <strong>${safeName}</strong> (${safeEmail}) added a new payout card.</p>
            <p><strong>Card:</strong> ${(0, html_escape_1.escapeHtml)(card.brand.toUpperCase())} ending in ${(0, html_escape_1.escapeHtml)(card.last4)}</p>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${(0, html_escape_1.escapeHtml)(url)}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">REVIEW CARDS</a>
            </div>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending payout-card notice:', error?.message);
        }
    }
    static async sendPayoutRequestedNotice(admin, driver, payout) {
        if (!admin.email)
            return;
        try {
            const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
            const url = `${env_1.env.ADMIN_URL}/payouts`;
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Unknown');
            const safeEmail = (0, html_escape_1.escapeHtml)(driver.email ?? '');
            await this.sendEmail({
                to: admin.email,
                subject: `Payout requested — ${dollars(payout.net_cents)} to ${driver.full_name ?? 'Driver'}`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #333;">On-demand payout awaiting processing</h2>
            <p>Driver <strong>${safeName}</strong> (${safeEmail}) requested a payout.</p>
            <p>
              Amount: <strong>${dollars(payout.amount_cents)}</strong><br/>
              Fee (5%): ${dollars(payout.fee_cents)}<br/>
              Net: <strong>${dollars(payout.net_cents)}</strong><br/>
              Method: ${(0, html_escape_1.escapeHtml)(payout.method)}
            </p>
            <div style="margin-top: 24px; text-align: center;">
              <a href="${(0, html_escape_1.escapeHtml)(url)}" style="background-color: #5B7760; color: white; padding: 14px 22px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">PROCESS PAYOUT</a>
            </div>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending payout-requested notice:', error?.message);
        }
    }
    static async sendPayoutReceiptEmail(driver, payout) {
        if (!driver.email)
            return;
        try {
            const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
            const safeName = (0, html_escape_1.escapeHtml)(driver.full_name ?? 'Driver');
            await this.sendEmail({
                to: driver.email,
                subject: 'Your payout has been sent',
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #eee;">
            <h2 style="color: #5B7760;">Payout sent</h2>
            <p>Hi ${safeName},</p>
            <p>Your recent payout has been processed.</p>
            <p>
              Net amount: <strong>${dollars(payout.net_cents)}</strong><br/>
              ${payout.reference ? `Reference: ${(0, html_escape_1.escapeHtml)(payout.reference)}<br/>` : ''}
            </p>
            <p style="color: #888; font-size: 12px;">If you don't see the funds in 1–3 business days, please reply to this email.</p>
          </div>
        `,
            });
        }
        catch (error) {
            console.error('❌ [GMAIL API] Error sending payout receipt email:', error?.message);
        }
    }
}
exports.EmailService = EmailService;
EmailService.oauth2Client = new googleapis_1.google.auth.OAuth2(env_1.env.GMAIL_CLIENT_ID, env_1.env.GMAIL_CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
EmailService.DOC_TYPE_LABELS = {
    license_photo_url: 'Driver License (Front)',
    license_photo_back_url: 'Driver License (Back)',
    insurance_photo_url: 'Insurance Certificate',
    registration_photo_url: 'Vehicle Registration',
    inspection_photo_url: 'Vehicle Inspection',
    id_photo_front_url: 'ID Card (Front)',
    id_photo_back_url: 'ID Card (Back)',
};
//# sourceMappingURL=email.service.js.map