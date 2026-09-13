import React from 'react';
import {
  Box, 
  Drawer, 
  AppBar, 
  Toolbar, 
  List, 
  Typography, 
  Divider, 
  IconButton, 
  ListItem, 
  ListItemButton, 
  ListItemIcon, 
  ListItemText,
  Avatar,
  Menu,
  MenuItem,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PeopleIcon from '@mui/icons-material/People';
import DriverIcon from '@mui/icons-material/LocalTaxi';
import HistoryIcon from '@mui/icons-material/History';
import LogoutIcon from '@mui/icons-material/Logout';
import LockIcon from '@mui/icons-material/Lock';
import MapIcon from '@mui/icons-material/Map';
import RouteIcon from '@mui/icons-material/Route';
import CompletedIcon from '@mui/icons-material/CheckCircle';
import SpeedingIcon from '@mui/icons-material/Speed';
import ProfileIcon from '@mui/icons-material/Badge';
import CardIcon from '@mui/icons-material/CreditCard';
import WalletIcon from '@mui/icons-material/AccountBalanceWallet';
import HandshakeIcon from '@mui/icons-material/Handshake';
import TagIcon from '@mui/icons-material/LocalOffer';
import ShareIcon from '@mui/icons-material/Share';
import StarsIcon from '@mui/icons-material/Stars';
import GroupsIcon from '@mui/icons-material/Groups';
import StorefrontIcon from '@mui/icons-material/Storefront';
import PriceChangeIcon from '@mui/icons-material/PriceChange';
import PaidIcon from '@mui/icons-material/Paid';
import FlagIcon from '@mui/icons-material/Flag';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getDangerousDrivers, listProfileChanges, listPayoutCards, listPayouts, getPendingDocumentReviewsCount } from '../api/admin';

const drawerWidth = 240;

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [dangerousCount, setDangerousCount] = React.useState(0);
  const [profileChangeCount, setProfileChangeCount] = React.useState(0);
  const [payoutCardCount, setPayoutCardCount] = React.useState(0);
  const [payoutCount, setPayoutCount] = React.useState(0);
  const [pendingDocReviewCount, setPendingDocReviewCount] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const d = await getDangerousDrivers();
        if (!cancelled) setDangerousCount(d?.drivers?.length ?? 0);
      } catch {
        // Sidebar badge is decorative — fail silently.
      }
      try {
        const p = await listProfileChanges('PENDING');
        if (!cancelled) setProfileChangeCount(p?.count ?? 0);
      } catch {
        // Sidebar badge is decorative — fail silently.
      }
      try {
        const pc = await listPayoutCards('PENDING');
        if (!cancelled) setPayoutCardCount(pc?.count ?? 0);
      } catch {
        // Sidebar badge is decorative — fail silently.
      }
      try {
        const po = await listPayouts('PENDING');
        if (!cancelled) setPayoutCount(po?.count ?? 0);
      } catch {
        // Sidebar badge is decorative — fail silently.
      }
      try {
        const count = await getPendingDocumentReviewsCount();
        if (!cancelled) setPendingDocReviewCount(count);
      } catch {
        // Sidebar badge is decorative — fail silently.
      }
    };
    load();
    // Refresh while admin is online so the badge stays current.
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const menuItems = [
    { text: 'Dashboard', icon: <DashboardIcon />, path: '/' },
    { text: 'Active Rides', icon: <RouteIcon />, path: '/rides/active' },
    { text: 'Completed Rides', icon: <CompletedIcon />, path: '/rides/completed' },
    { text: 'Live Monitoring', icon: <MapIcon />, path: '/monitoring' },
    { text: 'Riders', icon: <PeopleIcon />, path: '/riders' },
    { text: 'Drivers', icon: <DriverIcon />, path: '/drivers', badge: pendingDocReviewCount },
    { text: 'Speeding', icon: <SpeedingIcon />, path: '/speeding', badge: dangerousCount },
    { text: 'Profile Changes', icon: <ProfileIcon />, path: '/profile-changes', badge: profileChangeCount },
    { text: 'Payout Cards', icon: <CardIcon />, path: '/payout-cards', badge: payoutCardCount },
    { text: 'Payouts', icon: <WalletIcon />, path: '/payouts', badge: payoutCount },
    { text: 'Flagged Reviews', icon: <SpeedingIcon />, path: '/ratings/flagged' },
    { text: 'Partners', icon: <HandshakeIcon />, path: '/partners' },
    { text: 'Promo Codes', icon: <TagIcon />, path: '/promos' },
    { text: 'Referrals', icon: <ShareIcon />, path: '/referrals' },
    { text: 'Ride Credits', icon: <StarsIcon />, path: '/credits' },
    { text: 'Fleet Partners', icon: <GroupsIcon />, path: '/fleets' },
    { text: 'Sponsors', icon: <StorefrontIcon />, path: '/sponsors' },
    { text: 'Pricing', icon: <PriceChangeIcon />, path: '/pricing' },
    { text: 'Revenue', icon: <PaidIcon />, path: '/revenue' },
    { text: 'Reports', icon: <FlagIcon />, path: '/reports' },
    { text: 'Audit Logs', icon: <HistoryIcon />, path: '/logs' },
  ];

  const handleProfileMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleProfileMenuClose = () => {
    setAnchorEl(null);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleChangePassword = () => {
    handleProfileMenuClose();
    navigate('/change-password');
  };

  const closeDrawer = () => {
    if (isMobile) setMobileOpen(false);
  };

  const go = (path: string) => {
    closeDrawer();
    navigate(path);
  };

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar 
        position="fixed" 
        sx={{ 
          zIndex: (theme: any) => theme.zIndex.drawer + 1, 
          boxShadow: 'none',
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
          borderBottom: '1px solid rgba(0, 0, 0, 0.06)'
        }}
      >
        <Toolbar sx={{ justifyContent: 'space-between', px: { xs: 1.5, sm: 4 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            {isMobile && (
              <IconButton
                edge="start"
                aria-label="Open navigation"
                onClick={() => setMobileOpen(true)}
                sx={{ mr: 1, ml: -0.5 }}
              >
                <MenuIcon />
              </IconButton>
            )}
            <Box sx={{ 
              width: 36, 
              height: 36, 
              bgcolor: 'primary.main', 
              borderRadius: '10px', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              mr: 1.5,
              flexShrink: 0
            }}>
              <DashboardIcon sx={{ color: 'white', fontSize: 20 }} />
            </Box>
            <Typography variant="h6" noWrap component="div" sx={{ fontWeight: 800, letterSpacing: '-0.03em', fontSize: { xs: '1.05rem', sm: '1.25rem' } }}>
              NetRide <Typography component="span" sx={{ fontWeight: 400, color: 'text.secondary', ml: 0.5 }}>Admin</Typography>
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, mr: 1, display: { xs: 'none', sm: 'block' } }}>
              {user?.full_name}
            </Typography>
            <IconButton onClick={handleProfileMenuOpen} sx={{ p: 0.5, border: '2px solid transparent', '&:hover': { border: '2px solid #eee' } }}>
              <Avatar sx={{ width: 34, height: 34, bgcolor: 'primary.main', fontSize: 14, fontWeight: 700 }}>
                {user?.full_name?.charAt(0) || 'A'}
              </Avatar>
            </IconButton>
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={handleProfileMenuClose}
              {...({
                PaperProps: {
                  sx: { 
                    mt: 1.5, 
                    minWidth: 200, 
                    borderRadius: 3, 
                    boxShadow: '0 10px 40px rgba(0,0,0,0.1)',
                    border: '1px solid rgba(0,0,0,0.05)'
                  }
                }
              } as any)}
              transformOrigin={{ horizontal: 'right', vertical: 'top' }}
              anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
            >
              <MenuItem disabled sx={{ py: 1.5 }}>
                <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                  <Typography variant="subtitle2" sx={{ color: 'text.primary', fontWeight: 700 }}>{user?.full_name}</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{user?.email}</Typography>
                </Box>
              </MenuItem>
              <Divider />
              <MenuItem onClick={handleChangePassword} sx={{ py: 1.2, borderRadius: 2, mx: 1 }}>
                <ListItemIcon><LockIcon style={{ fontSize: 20 }} /></ListItemIcon>
                <ListItemText primary="Change Password" />
              </MenuItem>
              <MenuItem onClick={handleLogout} sx={{ py: 1.2, borderRadius: 2, mx: 1, color: 'error.main' }}>
                <ListItemIcon><LogoutIcon style={{ fontSize: 20, color: 'inherit' }} /></ListItemIcon>
                <ListItemText primary="Logout" />
              </MenuItem>
            </Menu>
          </Box>
        </Toolbar>
      </AppBar>
      <Drawer
        variant={isMobile ? 'temporary' : 'permanent'}
        open={isMobile ? mobileOpen : undefined}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: { width: drawerWidth, boxSizing: 'border-box', pt: 2 },
        }}
      >
        <Toolbar />
        <Box sx={{ overflow: 'auto', px: 2 }}>
          <List>
            {menuItems.map((item) => (
              <ListItem key={item.text} disablePadding sx={{ mb: 0.5 }}>
                <ListItemButton
                  selected={location.pathname === item.path}
                  onClick={() => go(item.path)}
                  sx={{
                    py: 1.2,
                    px: 2,
                    borderRadius: '12px',
                    transition: 'all 0.2s',
                    '&.Mui-selected': {
                      backgroundColor: 'primary.main',
                      color: 'white',
                      '& .MuiListItemIcon-root': { color: 'white' },
                      '&:hover': { backgroundColor: 'primary.main' },
                    },
                    '&:hover': {
                      backgroundColor: 'rgba(0,0,0,0.04)',
                    }
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}>
                    {React.cloneElement(item.icon as React.ReactElement, {
                      style: { fontSize: 20 }
                    } as any)}
                  </ListItemIcon>
                  <ListItemText
                    primary={item.text}
                  />
                  {(item as any).badge > 0 && (
                    <Box
                      sx={{
                        ml: 'auto',
                        minWidth: 22,
                        height: 22,
                        px: 0.75,
                        borderRadius: 11,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor:
                          location.pathname === item.path ? '#C65A5A' : '#FCE9E9',
                        color:
                          location.pathname === item.path ? 'white' : '#C65A5A',
                        fontSize: 11,
                        fontWeight: 800,
                        letterSpacing: 0.3,
                      }}
                    >
                      {(item as any).badge}
                    </Box>
                  )}
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, sm: 6 }, backgroundColor: 'background.default', minHeight: '100vh', width: { xs: '100%', md: 'auto' } }}>
        <Toolbar />
        <Box sx={{ maxWidth: '100%', mx: 'auto' }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
};

export default MainLayout;
