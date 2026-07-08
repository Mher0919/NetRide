import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    primary: {
      main: '#1a1a1a', // Richer black
      light: '#424242',
      dark: '#000000',
    },
    secondary: {
      main: '#5B7760', // NetRide Green
    },
    background: {
      default: '#f4f7f6', // Softer background
      paper: '#ffffff',
    },
    success: {
      main: '#2e7d32',
      light: '#edf7ed',
    },
    warning: {
      main: '#ed6c02',
      light: '#fff4e5',
    },
    error: {
      main: '#d32f2f',
      light: '#fdeded',
    },
    info: {
      main: '#0288d1',
      light: '#e5f6fd',
    },
  },
  shape: {
    borderRadius: 16, // More modern rounded corners
  },
  typography: {
    fontFamily: '"Inter", "Plus Jakarta Sans", "Roboto", sans-serif',
    h4: {
      fontWeight: 800,
      letterSpacing: '-0.02em',
    },
    h5: {
      fontWeight: 700,
      letterSpacing: '-0.01em',
    },
    h6: {
      fontWeight: 600,
    },
    subtitle1: {
      fontWeight: 600,
    },
    button: {
      fontWeight: 600,
      textTransform: 'none',
    },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          padding: '10px 20px',
          boxShadow: 'none',
          '&:hover': {
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          },
          '&.MuiButton-containedPrimary': {
            backgroundColor: '#1a1a1a',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          boxShadow: '0px 4px 20px rgba(0, 0, 0, 0.04)',
          border: '1px solid rgba(0, 0, 0, 0.05)',
        },
        elevation1: {
          boxShadow: '0px 4px 20px rgba(0, 0, 0, 0.04)',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 20,
          boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.05)',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid rgba(0, 0, 0, 0.05)',
          color: '#1a1a1a',
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#ffffff',
          borderRight: '1px solid rgba(0, 0, 0, 0.05)',
        },
      },
    },
  },
});
