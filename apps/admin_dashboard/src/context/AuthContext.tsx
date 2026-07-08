import React, { createContext, useContext, useState, useEffect } from 'react';

interface User {
  id: string;
  email: string;
  full_name: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (user: User, token: string) => void;
  logout: () => void;
  isAuthenticated: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('admin_token'));
  const [loading, setLoading] = useState(true);

  const TIMEOUT_DURATION = 30 * 60 * 1000; // 30 minutes

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    localStorage.removeItem('last_action');
  };

  useEffect(() => {
    const savedUser = localStorage.getItem('admin_user');
    const savedToken = localStorage.getItem('admin_token');
    const lastAction = localStorage.getItem('last_action');
    
    if (savedUser && savedToken) {
      // Check if session expired
      if (lastAction) {
        const now = new Date().getTime();
        const lastActionTime = parseInt(lastAction);
        if (now - lastActionTime > TIMEOUT_DURATION) {
          logout();
          setLoading(false);
          return;
        }
      }

      try {
        setUser(JSON.parse(savedUser));
        setToken(savedToken);
      } catch (e) {
        console.error('Failed to parse saved user', e);
        logout();
      }
    }
    setLoading(false);
  }, []);

  // Inactivity tracking
  useEffect(() => {
    if (!token) return;

    const handleAction = () => {
      localStorage.setItem('last_action', new Date().getTime().toString());
    };

    const interval = setInterval(() => {
      const lastAction = localStorage.getItem('last_action');
      if (lastAction) {
        const now = new Date().getTime();
        const lastActionTime = parseInt(lastAction);
        if (now - lastActionTime > TIMEOUT_DURATION) {
          logout();
        }
      }
    }, 60000); // Check every minute

    window.addEventListener('mousemove', handleAction);
    window.addEventListener('keypress', handleAction);
    window.addEventListener('click', handleAction);
    window.addEventListener('scroll', handleAction);

    return () => {
      clearInterval(interval);
      window.removeEventListener('mousemove', handleAction);
      window.removeEventListener('keypress', handleAction);
      window.removeEventListener('click', handleAction);
      window.removeEventListener('scroll', handleAction);
    };
  }, [token]);

  const login = (newUser: User, newToken: string) => {
    setUser(newUser);
    setToken(newToken);
    localStorage.setItem('admin_token', newToken);
    localStorage.setItem('admin_user', JSON.stringify(newUser));
    localStorage.setItem('last_action', new Date().getTime().toString());
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated: !!token, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
