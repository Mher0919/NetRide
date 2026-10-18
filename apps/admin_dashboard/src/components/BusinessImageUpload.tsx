import React from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import CloseIcon from '@mui/icons-material/Close';
import StorefrontIcon from '@mui/icons-material/Storefront';
import { uploadSponsorBusinessImage, deleteSponsorBusinessImage } from '../api/admin';
import { resolveApiUrl } from '../api';

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 8;
const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

interface Props {
  logoUrl: string | null;
  photoUrls: string[];
  onLogoChange: (url: string | null) => void;
  onPhotosChange: (urls: string[]) => void;
  disabled?: boolean;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Business logo + gallery uploader for the manual business-entry workflow.
 *
 * Client-side checks (size/count/type) are UX helpers only — the backend
 * re-validates the real file content (magic bytes), size and count. Uploads
 * go through NetRide's storage service and return portable `/api/files/:id`
 * URLs that are persisted on the sponsor record.
 */
const BusinessImageUpload: React.FC<Props> = ({
  logoUrl,
  photoUrls,
  onLogoChange,
  onPhotosChange,
  disabled = false,
}) => {
  const [uploadingLogo, setUploadingLogo] = React.useState(false);
  const [uploadingPhoto, setUploadingPhoto] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const logoInputRef = React.useRef<HTMLInputElement>(null);
  const photoInputRef = React.useRef<HTMLInputElement>(null);

  const errMsg = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

  const pickLogo = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    if (!ACCEPTED_TYPES.includes(file.type.toLowerCase())) {
      setError('Logo must be a JPEG, PNG, WebP or HEIC image.');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError('Logo is too large — maximum 2 MB.');
      return;
    }
    setUploadingLogo(true);
    try {
      const image = await readAsBase64(file);
      const { url } = await uploadSponsorBusinessImage({ image, mimetype: file.type, kind: 'logo' });
      onLogoChange(url);
    } catch (err) {
      setError(errMsg(err, 'Logo upload failed.'));
    } finally {
      setUploadingLogo(false);
    }
  };

  const pickPhotos = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setError(null);
    if (photoUrls.length + files.length > MAX_PHOTOS) {
      setError(`At most ${MAX_PHOTOS} photos are allowed.`);
      return;
    }
    setUploadingPhoto(true);
    const uploaded: string[] = [];
    try {
      for (const file of files) {
        if (!ACCEPTED_TYPES.includes(file.type.toLowerCase())) {
          setError(`"${file.name}" is not a supported image format.`);
          continue;
        }
        if (file.size > PHOTO_MAX_BYTES) {
          setError(`"${file.name}" is too large — maximum 5 MB per photo.`);
          continue;
        }
        const image = await readAsBase64(file);
        const { url } = await uploadSponsorBusinessImage({ image, mimetype: file.type, kind: 'photo' });
        uploaded.push(url);
      }
      if (uploaded.length) onPhotosChange([...photoUrls, ...uploaded]);
    } catch (err) {
      setError(errMsg(err, 'Photo upload failed.'));
    } finally {
      setUploadingPhoto(false);
    }
  };

  const removeLogo = () => {
    const previous = logoUrl;
    onLogoChange(null);
    // Best-effort cleanup of an unreferenced upload; the backend refuses to
    // delete images still referenced by a sponsor (they are cleaned up after
    // the next successful save instead).
    if (previous) void deleteSponsorBusinessImage(previous).catch(() => undefined);
  };

  const removePhoto = (url: string) => {
    onPhotosChange(photoUrls.filter((u) => u !== url));
    void deleteSponsorBusinessImage(url).catch(() => undefined);
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: 'center' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
          Branding & photos
        </Typography>
        <Typography variant="caption" color="text.secondary">
          JPEG/PNG/WebP/HEIC · logo ≤ 2 MB · photos ≤ 5 MB, max {MAX_PHOTOS}
        </Typography>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 1.5, borderRadius: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'flex-start' }}>
        {/* Logo */}
        <Box>
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 0.5 }}>
            Logo
          </Typography>
          <Box
            sx={{
              width: 96,
              height: 96,
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'divider',
              bgcolor: '#F7F7F5',
              backgroundImage: resolveApiUrl(logoUrl) ? `url(${resolveApiUrl(logoUrl)})` : 'none',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
          >
            {!resolveApiUrl(logoUrl) && <StorefrontIcon sx={{ color: '#9AA79E' }} />}
            {uploadingLogo && (
              <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'rgba(255,255,255,0.7)' }}>
                <CircularProgress size={22} />
              </Box>
            )}
            {logoUrl && !uploadingLogo && (
              <Tooltip title="Remove logo">
                <IconButton
                  size="small"
                  onClick={removeLogo}
                  disabled={disabled}
                  aria-label="Remove logo"
                  sx={{ position: 'absolute', top: -10, right: -10, bgcolor: 'background.paper', boxShadow: 1, '&:hover': { bgcolor: 'background.paper' } }}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
          <input ref={logoInputRef} type="file" accept={ACCEPTED_TYPES.join(',')} hidden onChange={pickLogo} />
          <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
            <Tooltip title={logoUrl ? 'Replace logo' : 'Upload logo'}>
              <span>
                <IconButton
                  size="small"
                  disabled={disabled || uploadingLogo}
                  onClick={() => logoInputRef.current?.click()}
                  aria-label={logoUrl ? 'Replace logo' : 'Upload logo'}
                >
                  <AddPhotoAlternateIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Box>

        {/* Gallery */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 0.5 }}>
            Business photos ({photoUrls.length}/{MAX_PHOTOS})
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {photoUrls.map((url) => (
              <Box
                key={url}
                sx={{
                  width: 72,
                  height: 72,
                  borderRadius: 2,
                  border: '1px solid',
                  borderColor: 'divider',
                  backgroundImage: `url(${resolveApiUrl(url)})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  position: 'relative',
                }}
              >
                <Tooltip title="Remove photo">
                  <IconButton
                    size="small"
                    onClick={() => removePhoto(url)}
                    disabled={disabled}
                    aria-label="Remove photo"
                    sx={{ position: 'absolute', top: -10, right: -10, bgcolor: 'background.paper', boxShadow: 1, '&:hover': { bgcolor: 'background.paper' } }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
            <Box
              role="button"
              tabIndex={0}
              aria-label="Add business photos"
              onClick={() => !disabled && !uploadingPhoto && photoInputRef.current?.click()}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !disabled) photoInputRef.current?.click();
              }}
              sx={{
                width: 72,
                height: 72,
                borderRadius: 2,
                border: '1px dashed',
                borderColor: 'divider',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: disabled ? 'not-allowed' : 'pointer',
                bgcolor: '#F7F7F5',
                '&:hover': { borderColor: 'primary.main' },
              }}
            >
              {uploadingPhoto ? <CircularProgress size={20} /> : <AddPhotoAlternateIcon sx={{ color: '#9AA79E' }} />}
            </Box>
          </Stack>
          <input
            ref={photoInputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            multiple
            hidden
            onChange={pickPhotos}
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Photos are public business branding shown alongside the SPECIAL.
          </Typography>
        </Box>
      </Stack>
    </Box>
  );
};

export default BusinessImageUpload;
