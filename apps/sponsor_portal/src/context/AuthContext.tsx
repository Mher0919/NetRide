import React, { createContext, useContext, useState, useEffect } from 'react';
import type { SponsorSession } from '../api/sponsor';
import { sponsorLogout } from '../api/sponsor';

interface AuthContextType {
  session: SponsorSession | null;
  login: (session: SponsorSession) => void;
  logout: () => void;
  isAuthenticated: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Restores the persisted session lazily (runs before first render). */
const readSession = (): SponsorSession | null => {
  try {
    const token = localStorage.getItem('sponsor_token');
    const refreshToken = localStorage.getItem('sponsor_refresh_token');
    const saved = localStorage.getItem('sponsor_user');
    if (token && refreshToken && saved) {
      const sponsor = JSON.parse(saved);
      return { token, refreshToken, sponsor };
    }
  } catch {
    localStorage.removeItem('sponsor_token');
    localStorage.removeItem('sponsor_user');
    localStorage.removeItem('sponsor_refresh_token');
  }
  return null;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<SponsorSession | null>(() => readSession());
  const [loading, setLoading] = useState(true);

  // Deferred past the current render so the loading flip never cascades
  // inside the effect (react-hooks/set-state-in-effect).
  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 0);
    return () => window.clearTimeout(t);
  }, []);

  const login = (s: SponsorSession) => {
    setSession(s);
    localStorage.setItem('sponsor_token', s.token);
    localStorage.setItem('sponsor_refresh_token', s.refreshToken);
    localStorage.setItem('sponsor_user', JSON.stringify(s.sponsor));
  };

  const logout = () => {
    const refreshToken = session?.refreshToken;
    setSession(null);
    localStorage.removeItem('sponsor_token');
    localStorage.removeItem('sponsor_user');
    localStorage.removeItem('sponsor_refresh_token');
    if (refreshToken) sponsorLogout(refreshToken);
  };

  return (
    <AuthContext.Provider value={{ session, login, logout, isAuthenticated: !!session, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

// Hook + provider intentionally share this module (standard context pattern).
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};