export declare class EmailService {
    private static oauth2Client;
    private static DOC_TYPE_LABELS;
    private static formatDocTypes;
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
    static sendProfileChangeNotice(admin: {
        email?: string;
    }, driver: {
        id: string;
        email?: string;
        full_name?: string;
    }, request: {
        id: string;
        requested_changes: any;
        card_last4?: string | null;
        card_brand?: string | null;
    }): Promise<void>;
    static sendProfileChangeSubmittedEmail(driver: {
        email?: string;
        full_name?: string;
    }, request: {
        id: string;
        requested_changes: any;
        card_last4?: string | null;
        card_brand?: string | null;
    }): Promise<void>;
    static sendProfileChangeApprovedEmail(driver: {
        email?: string;
        full_name?: string;
    }): Promise<void>;
    static sendProfileChangeRejectedEmail(driver: {
        email?: string;
        full_name?: string;
    }, reason: string): Promise<void>;
    static sendDocumentResubmissionRequestedEmail(driver: {
        email?: string;
        full_name?: string;
    }, info: {
        document_type: string;
        reason: string;
    }): Promise<void>;
    static sendDocumentResubmissionReviewedEmail(driver: {
        email?: string;
        full_name?: string;
    }, info: {
        document_type: string;
        decision: string;
    }): Promise<void>;
    static sendDriverDocumentResubmittedConfirmationEmail(driver: {
        email?: string;
        full_name?: string;
    }, info: {
        document_types: string[];
    }): Promise<void>;
    static sendAdminDocumentResubmissionNoticeEmail(admin: {
        email?: string;
    }, driver: {
        id: string;
        full_name?: string;
        email?: string;
    }, info: {
        document_types: string[];
        submitted_at: Date;
    }): Promise<void>;
    static sendPayoutCardNotice(admin: {
        email?: string;
    }, driver: {
        id: string;
        email?: string;
        full_name?: string;
    }, card: {
        id: string;
        brand: string;
        last4: string;
    }): Promise<void>;
    static sendPayoutRequestedNotice(admin: {
        email?: string;
    }, driver: {
        id: string;
        email?: string;
        full_name?: string;
    }, payout: {
        id: string;
        amount_cents: number;
        fee_cents: number;
        net_cents: number;
        method: string;
    }): Promise<void>;
    static sendPayoutReceiptEmail(driver: {
        email?: string;
        full_name?: string;
    }, payout: {
        id: string;
        amount_cents: number;
        fee_cents: number;
        net_cents: number;
        reference?: string | null;
    }): Promise<void>;
    /**
     * Notify all admin users that a driver's face check was flagged for review.
     * `admins` is a list of { email } rows (ADMIN role). Silently skips if no
     * Gmail credentials are configured.
     */
    static sendFaceCheckFlaggedNotice(admins: {
        email?: string;
    }[], info: {
        driverName?: string;
        driverEmail?: string;
        reason?: string;
        score?: number;
        eventId?: string;
    }): Promise<void>;
}
