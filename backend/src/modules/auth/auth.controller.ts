// backend/src/modules/auth/auth.controller.ts
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { z } from 'zod';
import { UserRole } from '../../types';
import { AuthRequest } from '../../middleware/auth.middleware';

const OAuthSchema = z.object({
  email: z.string().email(),
  full_name: z.string(),
  profile_image_url: z.string().optional(),
  role: z.nativeEnum(UserRole),
});

const SignupPasswordSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(2),
  password: z.string().min(6),
  role: z.nativeEnum(UserRole),
});

const LoginPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(6),
});

export class AuthController {
  static async signupPassword(req: Request, res: Response) {
    try {
      const validatedData = SignupPasswordSchema.parse(req.body);
      const result = await AuthService.signupWithPassword(validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async loginPassword(req: Request, res: Response) {
    try {
      const validatedData = LoginPasswordSchema.parse(req.body);
      const result = await AuthService.loginWithPassword(validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async changePassword(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validatedData = ChangePasswordSchema.parse(req.body);
      const result = await AuthService.changePassword(userId, validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async forgotPassword(req: Request, res: Response) {
    try {
      const { email } = ForgotPasswordSchema.parse(req.body);
      const result = await AuthService.forgotPassword(email);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async resetPassword(req: Request, res: Response) {
    try {
      const { token, newPassword } = ResetPasswordSchema.parse(req.body);
      const result = await AuthService.resetPassword(token, newPassword);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async renderResetPasswordForm(req: Request, res: Response) {
    const { token } = req.query;
    if (!token) return res.status(400).send('<h1>Invalid Link</h1>');

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
            <input type="hidden" name="token" value="${token}">
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
                body: JSON.stringify({ token: '${token}', newPassword: password })
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

  static async oauth(req: Request, res: Response) {
    try {
      const validatedData = OAuthSchema.parse(req.body);
      const result = await AuthService.handleOAuth(validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async requestOTP(req: Request, res: Response) {
    try {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      const result = await AuthService.requestOTP(email);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async verifyOTP(req: Request, res: Response) {
    try {
      const validatedData = z.object({
        email: z.string().email(),
        code: z.string().length(6),
        full_name: z.string().optional(),
        role: z.nativeEnum(UserRole).optional(),
      }).parse(req.body);
      const result = await AuthService.verifyOTP(validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
