import { Box, Typography, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';

const NotFound = () => {
  const navigate = useNavigate();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100dvh',
        textAlign: 'center',
        px: 2,
      }}
    >
      <Typography variant="h1" sx={{ fontWeight: 700, color: 'text.secondary', fontSize: { xs: 72, md: 120 } }}>
        404
      </Typography>
      <Typography variant="h5" sx={{ mt: 1, fontWeight: 600 }}>
        Page Not Found
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mt: 1, maxWidth: 400 }}>
        The page you are looking for does not exist or has been moved.
      </Typography>
      <Button
        variant="contained"
        size="large"
        sx={{ mt: 4 }}
        onClick={() => navigate('/')}
      >
        Return to Dashboard
      </Button>
    </Box>
  );
};

export default NotFound;
