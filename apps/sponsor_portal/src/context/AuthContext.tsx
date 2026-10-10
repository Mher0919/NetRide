import React, { createContext, useContext, useState, useEffect } from 'react';
import type { PortalSession, PortalInfo, ActivePortalType } from '../api/portal';
import { portalLogout } from '../api/portal';

interface AuthContextType {
  session: PortalSession | null;
  login: (session: PortalSession) => void;
  setActivePortal: (type: string) => PortalInfo | null;
  logout: () => void;
  isAuthenticated: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Synthetic portal entry for the combined 'ALL' view (not a real account). */
const allPortal = (email: string, portals: PortalInfo[]): PortalInfo => ({
  type: 'ALL',
  id: 'ALL',
  name: 'All dashboards',
  email,
  mustChangePassword: portals.some((p) => p.mustChangePassword),
});

/** Parses the persisted active type, falling back to the first portal. */
const restoreActivePortal = (portals: PortalInfo[], activeType: string | null): PortalInfo => {
  if (activeType === 'ALL' && portals.length > 1) {
    return allPortal(portals[0]?.email ?? '', portals);
  }
  return portals.find((p) => p.type === activeType) ?? portals[0];
};

/** Restores the persisted session lazily (runs before first render). */
const readSession = (): PortalSession | null => {
  try {
    const token = localStorage.getItem('portal_token');
    const refreshToken = localStorage.getItem('portal_refresh_token');
    const saved = localStorage.getItem('portal_user');
    if (token && refreshToken && saved) {
      const parsed = JSON.parse(saved);
      const portals = parsed.portals ?? (parsed.type ? [parsed] : []);
      const activeType = localStorage.getItem('portal_type');
      const portal = restoreActivePortal(portals, activeType);
      return { token, refreshToken, portals, portal };
    }
  } catch {
    localStorage.removeItem('portal_token');
    localStorage.removeItem('portal_user');
    localStorage.removeItem('portal_refresh_token');
    localStorage.removeItem('portal_type');
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
    localStorage.setItem('portal_user', JSON.stringify({ portals: s.portals, portal: s.portal }));
    localStorage.setItem('portal_type', s.portal.type);
  };

  /** Switch the visible dashboard between the account's portal types ('ALL' = combined view). */
  const setActivePortal = (type: string): PortalInfo | null => {
    if (!session) return null;
    if (type === 'ALL') {
      if (session.portals.length < 2) return null;
      const next = allPortal(session.portal.email, session.portals);
      setSession({ ...session, portal: next });
      localStorage.setItem('portal_type', 'ALL');
      localStorage.setItem('portal_user', JSON.stringify({ portals: session.portals, portal: next }));
      return next;
    }
    const next = session.portals.find((p) => p.type === (type as ActivePortalType)) ?? null;
    if (!next) return null;
    setSession({ ...session, portal: next });
    localStorage.setItem('portal_type', next.type);
    localStorage.setItem('portal_user', JSON.stringify({ portals: session.portals, portal: next }));
    return next;
  };

  const logout = () => {
    const refreshToken = session?.refreshToken;
    setSession(null);
    localStorage.removeItem('portal_token');
    localStorage.removeItem('portal_user');
    localStorage.removeItem('portal_refresh_token');
    localStorage.removeItem('portal_type');
    if (refreshToken) portalLogout(refreshToken);
  };

  return (
    <AuthContext.Provider value={{ session, login, setActivePortal, logout, isAuthenticated: !!session, loading }}>
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