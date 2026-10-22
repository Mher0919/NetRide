import React from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import DirectionsCarIcon from '@mui/icons-material/DirectionsCar';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import type { AppUpdateFormValues } from '../utils/appUpdates';
import { VERSION_PATTERN } from '../utils/appUpdates';

export type PreviewDevice = 'small' | 'standard' | 'large';

const DEVICE_SIZES: Record<
  PreviewDevice,
  { width: number; height: number; label: string }
> = {
  small: { width: 300, height: 560, label: 'Small phone' },
  standard: { width: 350, height: 700, label: 'Standard phone' },
  large: { width: 390, height: 780, label: 'Large phone' },
};

interface UpdatePopupPreviewProps {
  values: AppUpdateFormValues;
  device: PreviewDevice;
}

const UpdatePopupPreview: React.FC<UpdatePopupPreviewProps> = ({
  values,
  device,
}) => {
  const size = DEVICE_SIZES[device];
  const accent = values.accentColor || '#5B7760';
  const title = values.popupTitle.trim() || 'Update required';
  const message =
    values.popupMessage.trim() ||
    'A required update is ready. Please update to the latest version to continue using NetRide.';
  const buttonText = values.buttonText.trim() || 'Update Now';
  const supportingText = values.supportingText.trim();
  const announcement = values.announcementLabel.trim();
  const minimumVersion = VERSION_PATTERN.test(values.minimumVersion.trim())
    ? values.minimumVersion.trim()
    : null;

  return (
    <Stack spacing={1.5} sx={{ alignItems: 'center' }}>
      <Typography variant="caption" color="text.secondary">
        Live preview · {size.label}
      </Typography>
      <Box
        aria-label="Mandatory update popup preview"
        sx={{
          width: size.width,
          maxWidth: '100%',
          height: size.height,
          borderRadius: '38px',
          border: '9px solid #1a1a1a',
          bgcolor: '#EEEBE6',
          boxShadow: '0 18px 50px rgba(16, 24, 20, 0.22)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 92,
            height: 18,
            bgcolor: '#1a1a1a',
            borderRadius: '999px',
            zIndex: 2,
          }}
        />
        <Box
          sx={{
            height: '100%',
            overflowY: 'auto',
            px: 2.6,
            pt: 4.5,
            pb: 2.5,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box
              sx={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                bgcolor: accent,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <DirectionsCarIcon sx={{ fontSize: 17, color: '#ffffff' }} />
            </Box>
            <Typography
              sx={{
                fontSize: 14,
                fontWeight: 900,
                letterSpacing: '-0.03em',
                color: '#2F3A32',
              }}
            >
              NetRide
            </Typography>
          </Stack>

          <Stack
            spacing={1.4}
            sx={{
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
              py: 2,
            }}
          >
            {announcement && (
              <Chip
                size="small"
                label={announcement.toUpperCase()}
                sx={{
                  bgcolor: `${accent}18`,
                  color: accent,
                  fontWeight: 800,
                  fontSize: 9.5,
                  letterSpacing: '0.08em',
                  height: 24,
                }}
              />
            )}
            <Box
              sx={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                bgcolor: '#ffffff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 8px 24px rgba(16, 24, 20, 0.08)',
              }}
            >
              <SystemUpdateAltIcon sx={{ fontSize: 34, color: accent }} />
            </Box>
            <Typography
              sx={{
                fontSize: 22,
                lineHeight: 1.15,
                fontWeight: 900,
                letterSpacing: '-0.04em',
                textAlign: 'center',
                color: '#2F3A32',
              }}
            >
              {title}
            </Typography>
            <Typography
              sx={{
                fontSize: 12.5,
                lineHeight: 1.55,
                textAlign: 'center',
                color: '#2F3A32',
              }}
            >
              {message}
            </Typography>
            {supportingText && (
              <Box
                sx={{
                  width: '100%',
                  bgcolor: '#ffffff',
                  border: '1px solid #D8D2CA',
                  borderRadius: '14px',
                  px: 1.5,
                  py: 1.2,
                }}
              >
                <Typography
                  sx={{
                    fontSize: 11,
                    lineHeight: 1.5,
                    textAlign: 'center',
                    color: '#5f6b64',
                  }}
                >
                  {supportingText}
                </Typography>
              </Box>
            )}
            {minimumVersion && (
              <Box
                sx={{
                  bgcolor: '#F7F4EF',
                  border: '1px solid #D8D2CA',
                  borderRadius: '10px',
                  px: 1.5,
                  py: 0.7,
                }}
              >
                <Typography
                  sx={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: '#42573F',
                  }}
                >
                  Version {minimumVersion} or newer required
                </Typography>
              </Box>
            )}
            <Box
              role="presentation"
              sx={{
                width: '100%',
                mt: 0.8,
                bgcolor: accent,
                color: '#ffffff',
                borderRadius: '13px',
                py: 1.35,
                textAlign: 'center',
                fontWeight: 800,
                fontSize: 13,
                boxShadow: `0 8px 18px ${accent}33`,
              }}
            >
              {buttonText}
            </Box>
          </Stack>

          <Typography
            sx={{
              fontSize: 9.5,
              textAlign: 'center',
              color: '#5f6b64',
            }}
          >
            Installed version: 1.0.0 (preview)
          </Typography>
        </Box>
      </Box>
    </Stack>
  );
};

export default UpdatePopupPreview;
