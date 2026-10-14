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
  Button,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import CloseIcon from '@mui/icons-material/Close';
import StorefrontIcon from '@mui/icons-material/Storefront';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ValidationIcon from '@mui/icons-material/VerifiedUser';
import CustomersIcon from '@mui/icons-material/People';
import BudgetIcon from '@mui/icons-material/AccountBalanceWallet';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { tokens } from '../theme';

const drawerWidth = 240;

const typeLabel: Record<string, string> = {
  SPONSOR: 'Sponsor',
  PARTNER: 'Partner',
  FLEET: 'Fleet',
  ALL: 'All',
};

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, setActivePortal, logout } = useAuth();
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [switchEl, setSwitchEl] = React.useState<null | HTMLElement>(null);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const type = session?.portal.type ?? 'SPONSOR';
  const hasSponsor = session?.portals.some((p) => p.type === 'SPONSOR');
  const menuItems = [
    { text: 'Dashboard', icon: <DashboardIcon />, path: '/' },
    ...(type === 'SPONSOR' || (type === 'ALL' && hasSponsor)
      ? [
          { text: 'Validations', icon: <ValidationIcon />, path: '/validations' },
          { text: 'Customers', icon: <CustomersIcon />, path: '/customers' },
          { text: 'Budget & funding', icon: <BudgetIcon />, path: '/funding' },
          { text: 'Settings', icon: <SettingsIcon />, path: '/settings' },
        ]
      : []),
  ];

  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  const closeDrawer = () => {
    if (isMobile) setMobileOpen(false);
  };

  const go = (path: string) => {
    closeDrawer();
    navigate(path);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleSwitch = (portalType: string) => {
    const next = setActivePortal(portalType);
    setSwitchEl(null);
    if (next?.mustChangePassword) {
      navigate('/change-password');
    } else {
      navigate('/');
    }
  };

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar
          sx={{
            justifyContent: 'space-between',
            gap: 1,
            px: { xs: 2, sm: 3, lg: 4 },
          }}
        >
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
            <Box
              sx={{
                width: 36,
                height: 36,
                bgcolor: 'primary.main',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                mr: 1.5,
                flexShrink: 0,
              }}
            >
              <StorefrontIcon sx={{ color: 'white', fontSize: 20 }} />
            </Box>
            <Typography
              variant="h6"
              noWrap
              component="div"
              sx={{ fontWeight: 800, letterSpacing: '-0.03em', fontSize: { xs: '1.05rem', sm: '1.25rem' } }}
            >
              NetRide
              <Typography
                component="span"
                sx={{
                  fontWeight: 400,
                  color: 'text.secondary',
                  ml: 0.5,
                  display: { xs: 'none', sm: 'inline' },
                }}
              >
                {typeLabel[type]}
              </Typography>
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, flexShrink: 0 }}>
            {/* Dashboard switcher — one login can own sponsor + partner + fleet accounts */}
            {session && session.portals.length > 1 && (
              <>
                <Tooltip title="Switch dashboard">
                  <Button
                    size="small"
                    variant="outlined"
                    color="inherit"
                    startIcon={<SwapHorizIcon />}
                    aria-label="Switch dashboard"
                    onClick={(e) => setSwitchEl(e.currentTarget)}
                    sx={{
                      textTransform: 'none',
                      borderRadius: '10px',
                      mr: 0.5,
                      minWidth: 0,
                      px: { xs: 1, sm: 1.5 },
                      '& .MuiButton-startIcon': { mr: { xs: 0, sm: 0.5 } },
                    }}
                  >
                    <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                      {typeLabel[type]}
                    </Box>
                  </Button>
                </Tooltip>
                <Menu
                  anchorEl={switchEl}
                  open={Boolean(switchEl)}
                  onClose={() => setSwitchEl(null)}
                  slotProps={{ paper: { sx: { minWidth: 240, maxWidth: 320 } } }}
                >
                  <MenuItem disabled sx={{ py: 1 }}>
                    <Typography variant="caption" color="text.secondary">Switch dashboard</Typography>
                  </MenuItem>
                  {session.portals.length > 1 && (
                    <MenuItem
                      selected={type === 'ALL'}
                      onClick={() => handleSwitch('ALL')}
                      sx={{ py: 1, borderRadius: 2, mx: 1 }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: type === 'ALL' ? 800 : 600 }}>
                        All dashboards · combined
                      </Typography>
                    </MenuItem>
                  )}
                  {session.portals.map((p) => (
                    <MenuItem
                      key={p.type}
                      selected={p.type === type}
                      onClick={() => handleSwitch(p.type)}
                      sx={{ py: 1, borderRadius: 2, mx: 1 }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: p.type === type ? 800 : 600 }}>
                        {p.name} · {typeLabel[p.type]}
                      </Typography>
                    </MenuItem>
                  ))}
                </Menu>
              </>
            )}
            <Typography
              variant="body2"
              noWrap
              sx={{ fontWeight: 600, ml: 0.5, maxWidth: 200, display: { xs: 'none', sm: 'block' } }}
            >
              {session?.portal.name}
            </Typography>
            <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} sx={{ p: 0.5 }} aria-label="Account menu">
              <Avatar sx={{ width: 34, height: 34, bgcolor: 'secondary.main', fontSize: 14, fontWeight: 700 }}>
                {session?.portal.name?.charAt(0) || 'N'}
              </Avatar>
            </IconButton>
            <Menu
              anchorEl={anchorEl}
              open={Boolean(anchorEl)}
              onClose={() => setAnchorEl(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              slotProps={{ paper: { sx: { minWidth: 220, maxWidth: 320 } } }}
            >
              <MenuItem disabled sx={{ py: 1.5, opacity: '1 !important' }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
                    {session?.portal.name}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ wordBreak: 'break-all', whiteSpace: 'normal' }}
                  >
                    {session?.portal.email}
                  </Typography>
                </Box>
              </MenuItem>
              <Divider />
              <MenuItem onClick={handleLogout} sx={{ py: 1.2, borderRadius: 2, mx: 1, my: 0.5, color: 'error.main' }}>
                <ListItemIcon><LogoutIcon sx={{ fontSize: 20, color: 'inherit' }} /></ListItemIcon>
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
        <Toolbar sx={{ minHeight: { xs: 56, sm: 64 } }} />
        {isMobile && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1 }}>
            <IconButton aria-label="Close navigation" onClick={() => setMobileOpen(false)}>
              <CloseIcon />
            </IconButton>
          </Box>
        )}
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
                    borderRadius: tokens.radius.control,
                    minHeight: 44,
                    '&.Mui-selected': {
                      backgroundColor: 'primary.main',
                      color: 'white',
                      '& .MuiListItemIcon-root': { color: 'white' },
                      '&:hover': { backgroundColor: 'primary.main' },
                    },
                    '&:hover': { backgroundColor: 'rgba(0,0,0,0.04)' },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}>
                    {React.cloneElement(item.icon, { sx: { fontSize: 20 } })}
                  </ListItemIcon>
                  <ListItemText primary={item.text} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: { xs: 2, sm: 3, lg: 4 },
          backgroundColor: 'background.default',
          minHeight: '100dvh',
          width: { xs: '100%', md: 'auto' },
          minWidth: 0,
        }}
      >
        <Toolbar sx={{ minHeight: { xs: 56, sm: 64 } }} />
        <Box sx={{ maxWidth: tokens.maxContentWidth, width: '100%', mx: 'auto' }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
};

export default MainLayout;
