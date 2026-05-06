export declare class EmailService {
    private static oauth2Client;
    private static getGmailClient;
    /**
     * Internal helper to send emails using Gmail API but with Nodemailer's
     * easy MIME/Attachment generation.
     */
    private static sendEmail;
    /**
     * Helper to resolve an image URL (data or http) to a CID attachment.
     */
    private static getAttachment;
    static sendPasswordChangeVerification(email: string, fullName: string, token: string): Promise<void>;
    static sendOTP(email: string, code: string): Promise<void>;
    static sendDriverRegistrationNotice(data: any): Promise<void>;
    static sendRiderVerificationNotice(user: any, idFrontUrl: string, idBackUrl: string): Promise<void>;
    static sendPasswordResetLink(email: string, fullName: string, token: string): Promise<void>;
    static sendEmailChangeLink(email: string, fullName: string, token: string): Promise<void>;
}
