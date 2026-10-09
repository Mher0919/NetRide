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
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
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

const drawerWidth = 240;

const typeLabel: Record<string, string> = {
  SPONSOR: 'Sponsor',
  PARTNER: 'Partner',
  FLEET: 'Fleet',
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
  const menuItems = [
    { text: 'Dashboard', icon: <DashboardIcon />, path: '/' },
    ...(type === 'SPONSOR'
      ? [
          { text: 'Validations', icon: <ValidationIcon />, path: '/validations' },
          { text: 'Customers', icon: <CustomersIcon />, path: '/customers' },
          { text: 'Budget & funding', icon: <BudgetIcon />, path: '/funding' },
          { text: 'Settings', icon: <SettingsIcon />, path: '/settings' },
        ]
      : []),
  ];

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
      <AppBar
        position="fixed"
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, boxShadow: 'none', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderBottom: '1px solid rgba(0, 0, 0, 0.06)' }}
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
            <Box sx={{ width: 36, height: 36, bgcolor: 'primary.main', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', mr: 1.5, flexShrink: 0 }}>
              <StorefrontIcon sx={{ color: 'white', fontSize: 20 }} />
            </Box>
            <Typography variant="h6" noWrap component="div" sx={{ fontWeight: 800, letterSpacing: '-0.03em', fontSize: { xs: '1.05rem', sm: '1.25rem' } }}>
              NetRide <Typography component="span" sx={{ fontWeight: 400, color: 'text.secondary', ml: 0.5 }}>{typeLabel[type]}</Typography>
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {/* Dashboard switcher — one login can own sponsor + partner + fleet accounts */}
            {session && session.portals.length > 1 && (
              <>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<SwapHorizIcon />}
                  onClick={(e) => setSwitchEl(e.currentTarget)}
                  sx={{ textTransform: 'none', borderRadius: 8, mr: 1 }}
                >
                  {typeLabel[type]}
                </Button>
                <Menu anchorEl={switchEl} open={Boolean(switchEl)} onClose={() => setSwitchEl(null)}>
                  <MenuItem disabled sx={{ py: 1 }}>
                    <Typography variant="caption" color="text.secondary">Switch dashboard</Typography>
                  </MenuItem>
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
            <Typography variant="body2" sx={{ fontWeight: 600, mr: 1, display: { xs: 'none', sm: 'block' } }}>
              {session?.portal.name}
            </Typography>
            <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} sx={{ p: 0.5 }}>
              <Avatar sx={{ width: 34, height: 34, bgcolor: 'secondary.main', fontSize: 14, fontWeight: 700 }}>
                {session?.portal.name?.charAt(0) || 'N'}
              </Avatar>
            </IconButton>
            <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
              <MenuItem disabled sx={{ py: 1.5 }}>
                <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{session?.portal.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{session?.portal.email}</Typography>
                </Box>
              </MenuItem>
              <Divider />
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
                    {React.cloneElement(item.icon, { style: { fontSize: 20 } })}
                  </ListItemIcon>
                  <ListItemText primary={item.text} />
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