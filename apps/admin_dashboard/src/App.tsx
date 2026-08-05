import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Box, CircularProgress } from '@mui/material';
import { theme } from './theme';
import { AuthProvider, useAuth } from './context/AuthContext';

// Pages
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/Dashboard';
import UserDetail from './pages/UserDetail';
import AuditLogs from './pages/AuditLogs';
import Rides from './pages/Rides';
import LiveMonitoring from './pages/LiveMonitoring';
import RideDetail from './pages/RideDetail';
import RideAudit from './pages/RideAudit';
import SpeedingViolations from './pages/SpeedingViolations';
import ProfileChanges from './pages/ProfileChanges';
import ProfileChangeDetail from './pages/ProfileChangeDetail';
import PayoutCards from './pages/PayoutCards';
import Payouts from './pages/Payouts';
import FlaggedRatings from './pages/FlaggedRatings';
import Partners from './pages/Partners';
import Promos from './pages/Promos';
import Referrals from './pages/Referrals';
import Credits from './pages/Credits';
import NotFound from './pages/NotFound';
import UserTable from './components/UserTable';
import MainLayout from './components/MainLayout';
import ErrorBoundary from './components/ErrorBoundary';

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }
  
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
};

const App: React.FC = () => {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/change-password" element={<ChangePassword />} />
            
            <Route path="/" element={
              <ProtectedRoute>
                <ErrorBoundary>
                  <MainLayout />
                </ErrorBoundary>
              </ProtectedRoute>
            }>
              <Route index element={<Dashboard />} />
              <Route path="rides/active" element={<Rides status="ACTIVE" title="Live Active Rides" />} />
              <Route path="rides/completed" element={<Rides status="COMPLETED" title="Historical Completed Rides" />} />
              <Route path="rides/:id" element={<RideDetail />} />
              <Route path="rides/:id/audit" element={<RideAudit />} />
              <Route path="monitoring" element={<LiveMonitoring />} />
              <Route path="riders" element={<UserTable role="RIDER" title="Riders Management" />} />
              <Route path="drivers" element={<UserTable role="DRIVER" title="Drivers Management" />} />
              <Route path="users/:id" element={<UserDetail />} />
              <Route path=":section/users/:id" element={<UserDetail />} />
              <Route path="logs" element={<AuditLogs />} />
              <Route path="speeding" element={<SpeedingViolations />} />
              <Route path="profile-changes" element={<ProfileChanges />} />
              <Route path="profile-changes/:id" element={<ProfileChangeDetail />} />
              <Route path="payout-cards" element={<PayoutCards />} />
              <Route path="payouts" element={<Payouts />} />
              <Route path="ratings/flagged" element={<FlaggedRatings />} />
              <Route path="partners" element={<Partners />} />
              <Route path="promos" element={<Promos />} />
              <Route path="referrals" element={<Referrals />} />
              <Route path="credits" element={<Credits />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Router>
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;
