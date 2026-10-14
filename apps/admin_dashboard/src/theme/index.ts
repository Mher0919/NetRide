import { createTheme } from '@mui/material/styles';

/**
 * NetRide design tokens.
 *
 * Numeric `borderRadius` values in `sx` are multiplied by `shape.borderRadius`,
 * so page-level styles should use explicit pixel strings (e.g. '16px') from
 * these tokens rather than raw numbers.
 */
export const tokens = {
  color: {
    black: '#1a1a1a',
    blackSoft: '#424242',
    green: '#5B7760',
    greenSoft: '#6E8B74',
    greenTint: '#EDF2EE',
    bg: '#f4f7f6',
    surface: '#ffffff',
    textSecondary: '#5f6b64',
    border: 'rgba(26, 42, 33, 0.10)',
  },
  radius: {
    control: '12px',
    card: '16px',
    pill: '999px',
  },
  space: {
    page: { xs: 2, sm: 3, lg: 4 },
  },
  maxContentWidth: 1400,
} as const;

export const theme = createTheme({
  palette: {
    primary: {
      main: '#1a1a1a',
      light: '#424242',
      dark: '#000000',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#5B7760',
      light: '#6E8B74',
      dark: '#42573F',
    },
    background: {
      default: '#f4f7f6',
      paper: '#ffffff',
    },
    text: {
      primary: '#1a1a1a',
      secondary: '#5f6b64',
    },
    divider: 'rgba(26, 42, 33, 0.08)',
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
    borderRadius: 12,
  },
  typography: {
    fontFamily: '"Inter", "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif',
    h4: {
      fontSize: '1.75rem',
      fontWeight: 800,
      letterSpacing: '-0.02em',
    },
    h5: {
      fontSize: '1.375rem',
      fontWeight: 700,
      letterSpacing: '-0.01em',
    },
    h6: {
      fontSize: '1.125rem',
      fontWeight: 700,
    },
    subtitle1: {
      fontWeight: 600,
    },
    subtitle2: {
      fontWeight: 600,
    },
    body1: {
      lineHeight: 1.55,
    },
    body2: {
      lineHeight: 1.5,
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
          borderRadius: tokens.radius.control,
          boxShadow: 'none',
          '&:hover': {
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.10)',
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        sizeSmall: {
          padding: 6,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          boxShadow: '0px 1px 2px rgba(16, 24, 20, 0.04), 0px 8px 24px rgba(16, 24, 20, 0.05)',
          border: '1px solid rgba(26, 42, 33, 0.06)',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: tokens.radius.card,
          border: '1px solid rgba(26, 42, 33, 0.06)',
          boxShadow: '0px 1px 2px rgba(16, 24, 20, 0.04), 0px 8px 24px rgba(16, 24, 20, 0.05)',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: tokens.radius.control,
          backgroundColor: '#ffffff',
          fontSize: '0.95rem',
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontSize: '0.95rem',
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottomColor: 'rgba(26, 42, 33, 0.08)',
        },
        head: {
          fontWeight: 700,
          fontSize: '0.75rem',
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          color: '#5f6b64',
          backgroundColor: '#fafcfb',
          whiteSpace: 'nowrap',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(255, 255, 255, 0.92)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid rgba(26, 42, 33, 0.08)',
          color: '#1a1a1a',
          boxShadow: 'none',
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#ffffff',
          borderRight: '1px solid rgba(26, 42, 33, 0.08)',
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: tokens.radius.card,
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          fontSize: '1.05rem',
          fontWeight: 700,
          paddingBottom: 4,
        },
      },
    },
    MuiDialogContent: {
      styleOverrides: {
        root: {
          paddingTop: '12px !important',
        },
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: {
          padding: '12px 24px 20px',
          gap: 8,
          flexWrap: 'wrap',
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          fontSize: '0.78rem',
          borderRadius: 8,
          backgroundColor: 'rgba(26, 26, 26, 0.92)',
        },
      },
    },
    MuiListItemText: {
      styleOverrides: {
        primary: {
          fontSize: '0.95rem',
        },
      },
    },
  },
});