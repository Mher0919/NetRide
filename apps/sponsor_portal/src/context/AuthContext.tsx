import React, { createContext, useContext, useState, useEffect } from 'react';
import type { SponsorSession } from '../api/sponsor';

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
    const saved = localStorage.getItem('sponsor_user');
    if (token && saved) return { token, sponsor: JSON.parse(saved) };
  } catch {
    localStorage.removeItem('sponsor_token');
    localStorage.removeItem('sponsor_user');
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
    localStorage.setItem('sponsor_user', JSON.stringify(s.sponsor));
  };

  const logout = () => {
    setSession(null);
    localStorage.removeItem('sponsor_token');
    localStorage.removeItem('sponsor_user');
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