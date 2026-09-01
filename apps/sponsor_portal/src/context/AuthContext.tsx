import React, { createContext, useContext, useState, useEffect } from 'react';
import type { PortalSession } from '../api/portal';
import { portalLogout } from '../api/portal';

interface AuthContextType {
  session: PortalSession | null;
  login: (session: PortalSession) => void;
  logout: () => void;
  isAuthenticated: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Restores the persisted session lazily (runs before first render). */
const readSession = (): PortalSession | null => {
  try {
    const token = localStorage.getItem('portal_token');
    const refreshToken = localStorage.getItem('portal_refresh_token');
    const saved = localStorage.getItem('portal_user');
    if (token && refreshToken && saved) {
      const portal = JSON.parse(saved);
      return { token, refreshToken, portal };
    }
  } catch {
    localStorage.removeItem('portal_token');
    localStorage.removeItem('portal_user');
    localStorage.removeItem('portal_refresh_token');
  }
  return null;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<PortalSession | null>(() => readSession());
  const [loading, setLoading] = useState(true);

  // Deferred past the current render so the loading flip never cascades
  // inside the effect (react-hooks/set-state-in-effect).
  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 0);
    return () => window.clearTimeout(t);
  }, []);

  const login = (s: PortalSession) => {
    setSession(s);
    localStorage.setItem('portal_token', s.token);
    localStorage.setItem('portal_refresh_token', s.refreshToken);
    localStorage.setItem('portal_user', JSON.stringify(s.portal));
  };

  const logout = () => {
    const refreshToken = session?.refreshToken;
    setSession(null);
    localStorage.removeItem('portal_token');
    localStorage.removeItem('portal_user');
    localStorage.removeItem('portal_refresh_token');
    if (refreshToken) portalLogout(refreshToken);
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