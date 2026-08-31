import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { partnerLogin, partnerForgotPassword, partnerVerifyResetOTP, partnerResetPassword, partnerChangePassword } from '../../api/partner';

export const PartnerLogin: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const session = await partnerLogin(email, password);
      localStorage.setItem('partner_token', session.token);
      localStorage.setItem('partner_refresh_token', session.refreshToken);
      localStorage.setItem('partner_user', JSON.stringify({
        id: session.partner.id,
        email: session.partner.email,
      }));
      navigate('/partner/dashboard');
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await partnerForgotPassword(email);
      alert('If that email is registered, a reset link has been sent.');
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Failed to send reset link');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyResetOTP = async (e: React.FormEvent, email: string, code: string) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const resetToken = await partnerVerifyResetOTP(email, code);
      localStorage.setItem('partner_reset_token', resetToken.resetToken);
      navigate('/partner/auth/reset-password');
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Invalid OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent, resetToken: string, newPassword: string) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await partnerResetPassword(resetToken, newPassword);
      alert('Password reset successful. Please login.');
      navigate('/partner/auth/login');
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent, newPassword: string) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await partnerChangePassword(newPassword);
      alert('Password changed successfully.');
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div>Logging in...</div>;
  }

  return (
    <div className="auth-page">
      <h2>Partner Login</h2>
      <form onSubmit={handleLogin} className="auth-form">
        <div className="form-group">
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? 'Logging in...' : 'Login'}
        </button>
      </form>
      <p className="link-text">
        Don't have an account?{' '}
        {/* Would link to partner registration - handled via admin */}
      </p>
    </div>
  );
};