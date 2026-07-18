import React from 'react';
import { Box, Typography, Button } from '@mui/material';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', px: 4, textAlign: 'center' }}>
          <Typography variant="h5" sx={{ fontWeight: 800, mb: 1 }}>Something went wrong</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3, maxWidth: 480 }}>
            {this.state.error?.message || 'An unexpected error occurred while loading this page.'}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button variant="outlined" onClick={() => window.location.href = '/'}>
              Back to Dashboard
            </Button>
            <Button variant="contained" onClick={() => this.setState({ hasError: false, error: null })}>
              Retry
            </Button>
          </Box>
        </Box>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
