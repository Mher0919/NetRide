"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const auth_service_1 = require("./auth.service");
const zod_1 = require("zod");
const types_1 = require("../../types");
// Self-registration roles. ADMIN/PARTNER/FLEET accounts are provisioned by
// administrators only — the public auth surface must never mint them.
const PublicRoleSchema = zod_1.z.enum([types_1.UserRole.RIDER, types_1.UserRole.DRIVER]);
const OAuthSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    full_name: zod_1.z.string(),
    profile_image_url: zod_1.z.string().nullable().optional(),
    role: PublicRoleSchema,
    // Mandatory: proves ownership of the email via Supabase. Without it the
    // endpoint would allow account impersonation.
    token: zod_1.z.string().min(10),
});
const SignupPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    full_name: zod_1.z.string().min(2),
    password: zod_1.z.string().min(6),
    role: PublicRoleSchema,
});
const LoginPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string(),
    trusted_device_token: zod_1.z.string().nullable().optional(),
    app_role: PublicRoleSchema.optional(),
});
const ChangePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().optional(),
    newPassword: zod_1.z.string().min(6),
});
const ForgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
});
const ResetPasswordSchema = zod_1.z.object({
    token: zod_1.z.string(),
    newPassword: zod_1.z.string().min(6),
});
const RequestPasswordChangeSchema = zod_1.z.object({
    currentPassword: zod_1.z.string(),
});
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function jsStringLiteral(value) {
    return JSON.stringify(String(value)).replace(/</g, '\\u003c');
}
const RESET_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class AuthController {
    static async signupPassword(req, res) {
        try {
            const validatedData = SignupPasswordSchema.parse(req.body);
            const result = await auth_service_1.AuthService.signupWithPassword(validatedData);
            res.json(result);
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return res.status(400).json({ error: 'Invalid input data. Please check all fields.' });
            }
            console.error(`[AUTH] ❌ Signup error:`, error.message);
            const message = error.message.includes('already exists')
                ? 'An account with this email already exists.'
                : 'Sign up failed. Please try again later.';
            res.status(400).json({ error: message });
        }
    }
    static async loginPassword(req, res) {
        try {
            const { email, password, trusted_device_token, app_role } = LoginPasswordSchema.parse(req.body);
            const result = await auth_service_1.AuthService.loginWithPassword({ email, password, trusted_device_token, app_role });
            res.json(result);
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return res.status(400).json({ error: 'Email and password are required.' });
            }
            console.error(`[AUTH] ❌ Login error:`, error.message);
            const message = (error.message.includes('not found') || error.message.includes('Invalid password'))
                ? 'Incorrect email or password.'
                : 'Login failed. Please try again.';
            res.status(401).json({ error: message });
        }
    }
    static async changePassword(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Session expired. Please login again.' });
            const validatedData = ChangePasswordSchema.parse(req.body);
            const result = await auth_service_1.AuthService.changePassword(userId, validatedData, req.user?.role);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Change password error:`, error.message);
            const message = error.message.includes('incorrect')
                ? 'The current password you entered is incorrect.'
                : error.message.includes('required') || error.message.includes('expired')
                    ? 'Your current password is required.'
                    : 'Failed to update password. Please try again.';
            res.status(400).json({ error: message });
        }
    }
    static async forgotPassword(req, res) {
        try {
            const { email } = ForgotPasswordSchema.parse(req.body);
            const result = await auth_service_1.AuthService.forgotPassword(email);
            res.json(result);
        }
        catch (error) {
            // For security, we always return the same response even if the user is
            // not found. The attempted address is deliberately NOT logged (PII).
            res.json({ message: 'If an account exists with this email, you will receive a reset link.' });
        }
    }
    static async resetPassword(req, res) {
        try {
            const { token, newPassword } = ResetPasswordSchema.parse(req.body);
            const result = await auth_service_1.AuthService.resetPassword(token, newPassword);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Reset password error:`, error.message);
            res.status(400).json({ error: 'This link has expired or is invalid.' });
        }
    }
    static async requestPasswordChange(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { currentPassword } = RequestPasswordChangeSchema.parse(req.body);
            const result = await auth_service_1.AuthService.requestPasswordChange(userId, currentPassword);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Request password change error:`, error.message);
            const message = error.message.includes('incorrect')
                ? 'The password you entered is incorrect.'
                : 'Failed to send verification email.';
            res.status(400).json({ error: message });
        }
    }
    static async deleteAccount(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await auth_service_1.AuthService.deleteAccount(userId);
            res.json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async deactivateAccount(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const result = await auth_service_1.AuthService.deactivateAccount(userId);
            res.json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async renderResetPasswordForm(req, res) {
        const { token } = req.query;
        if (!token || typeof token !== 'string' || !RESET_TOKEN_RE.test(token)) {
            return res.status(400).send('<h1>Invalid Link</h1>');
        }
        const safeTokenAttr = escapeHtml(token);
        const safeTokenJs = jsStringLiteral(token);
        res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Reset Password</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; display: flex; justify-content: center; padding: 50px; background: #f4f4f4; }
          .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
          h2 { margin-bottom: 20px; }
          input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: black; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Create New Password</h2>
          <p>Please enter your new password below.</p>
          <form id="resetForm">
            <input type="hidden" name="token" value="${safeTokenAttr}">
            <input type="password" id="password" placeholder="New Password" required minlength="6">
            <input type="password" id="confirm" placeholder="Confirm New Password" required minlength="6">
            <button type="submit" id="submitBtn">Update Password</button>
          </form>
          <div id="message" style="margin-top: 20px; text-align: center; display: none;"></div>
        </div>

        <script>
          document.getElementById('resetForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('password').value;
            const confirm = document.getElementById('confirm').value;
            const submitBtn = document.getElementById('submitBtn');
            const messageDiv = document.getElementById('message');

            if (password !== confirm) {
              alert('Passwords do not match');
              return;
            }

            submitBtn.disabled = true;
            submitBtn.innerText = 'Updating...';

            try {
              const response = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: ${safeTokenJs}, newPassword: password })
              });
              const data = await response.json();
              if (response.ok) {
                messageDiv.style.display = 'block';
                messageDiv.innerHTML = '<h3 style="color: green;">✅ Success!</h3><p>Your password has been updated. You can now login in the app.</p>';
                document.getElementById('resetForm').style.display = 'none';
              } else {
                alert('Error: ' + data.error);
                submitBtn.disabled = false;
                submitBtn.innerText = 'Update Password';
              }
            } catch (err) {
              alert('Something went wrong. Please try again.');
              submitBtn.disabled = false;
              submitBtn.innerText = 'Update Password';
            }
          });
        </script>
      </body>
      </html>
    `);
    }
    static async oauth(req, res) {
        try {
            const validatedData = OAuthSchema.parse(req.body);
            const result = await auth_service_1.AuthService.handleOAuth(validatedData);
            res.json(result);
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return res.status(400).json({ error: 'Invalid authentication request.' });
            }
            console.error(`[AUTH] ❌ OAuth error:`, error.message || error);
            res.status(400).json({ error: error.message });
        }
    }
    static async requestOTP(req, res) {
        try {
            const { email } = zod_1.z.object({ email: zod_1.z.string().email() }).parse(req.body);
            const result = await auth_service_1.AuthService.requestOTP(email);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ OTP request error: ${error.message}`);
            res.status(400).json({ error: 'Failed to send verification code. Please try again.' });
        }
    }
    static async verifyOTP(req, res) {
        try {
            const validatedData = zod_1.z.object({
                email: zod_1.z.string().email(),
                code: zod_1.z.string().length(6),
                full_name: zod_1.z.string().optional(),
                role: PublicRoleSchema.optional(),
            }).parse(req.body);
            const result = await auth_service_1.AuthService.verifyOTP(validatedData);
            res.json(result);
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return res.status(400).json({ error: 'Invalid or expired verification code.' });
            }
            console.error(`[AUTH] ❌ OTP verification error: ${error.message}`);
            res.status(400).json({ error: 'Invalid or expired verification code.' });
        }
    }
    static async requestPhoneOTP(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { phone_number, role } = zod_1.z.object({
                phone_number: zod_1.z.string(),
                role: zod_1.z.string().optional(),
            }).parse(req.body);
            const result = await auth_service_1.AuthService.requestPhoneOTP(userId, phone_number, role);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Phone OTP request error: ${error.message}`);
            res.status(400).json({ error: error.message || 'Failed to send SMS code.' });
        }
    }
    static async verifyPhoneOTP(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const { phone_number, code, role } = zod_1.z.object({
                phone_number: zod_1.z.string(),
                code: zod_1.z.string().min(4).max(10),
                role: zod_1.z.string().optional(),
            }).parse(req.body);
            const result = await auth_service_1.AuthService.verifyPhoneOTP(userId, phone_number, code, role);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Phone OTP verification error: ${error.message}`);
            res.status(400).json({ error: 'Invalid SMS verification code.' });
        }
    }
    static async requestAdmin2FA(req, res) {
        try {
            const { email } = zod_1.z.object({ email: zod_1.z.string().email() }).parse(req.body);
            const result = await auth_service_1.AuthService.requestAdmin2FA(email);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Admin 2FA request error: ${error.message}`);
            res.status(400).json({ error: 'Failed to send administrative verification code.' });
        }
    }
    static async verifyAdmin2FA(req, res) {
        try {
            const { email, code } = zod_1.z.object({
                email: zod_1.z.string().email(),
                code: zod_1.z.string().length(6),
            }).parse(req.body);
            const result = await auth_service_1.AuthService.verifyAdmin2FA(email, code);
            res.json(result);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Admin 2FA verification error: ${error.message}`);
            res.status(401).json({ error: 'Invalid administrative security code.' });
        }
    }
    static async getOnboardingStatus(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const status = await auth_service_1.AuthService.getOnboardingStatus(userId);
            res.json(status);
        }
        catch (error) {
            console.error(`[AUTH] ❌ Onboarding status error: ${error.message}`);
            res.status(500).json({ error: 'Failed to determine onboarding status.' });
        }
    }
    static async getPublicConfig(req, res) {
        // Exposes the canonical application identity so clients can assert the
        // correct OAuth branding ("Logging in for NetRide"). The actual consent
        // screen name is configured in Supabase Auth → Providers → Google and the
        // Google Cloud OAuth consent screen, but this guarantees clients render
        // the right product name everywhere.
        res.json({
            app_name: 'NetRide',
            auth_brand: 'NetRide',
        });
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=auth.controller.js.map