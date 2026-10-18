import React from 'react';
import {
  Box,
  Button,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  TextField,
  InputAdornment,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import StarHalfIcon from '@mui/icons-material/StarHalf';
import StarBorderIcon from '@mui/icons-material/StarBorder';

interface Props {
  /** 0–5 in 0.1 steps, or null when unset. */
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  /** Field label; defaults to "Rating (admin-entered)". */
  label?: string;
  /** Optional maximum for the numeric field (default 5). */
  max?: number;
  helperText?: string;
}

/**
 * Star-rating control kept in sync with a numeric input. Both controls edit
 * the SAME value: (a) clicking a star sets a whole-star value, (b) typing
 * accepts 0–5 with one decimal. This value is ADMIN-ENTERED — the UI labels
 * it as such and it is never presented as a Google rating.
 */
const StarRatingInput: React.FC<Props> = ({
  value,
  onChange,
  disabled = false,
  label = 'Rating (admin-entered)',
  max = 5,
  helperText = 'Administrator-entered rating. This is not a verified Google rating.',
}) => {
  const [text, setText] = React.useState(value == null ? '' : String(value));
  // Adjust the editable text when the value changes from the outside
  // (stars clicked, form reset, sponsor loaded) — the React-recommended
  // alternative to a state-syncing effect.
  const [lastValue, setLastValue] = React.useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(value == null ? '' : String(value));
  }

  const handleText = (raw: string) => {
    setText(raw);
    if (raw.trim() === '') {
      onChange(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (n < 0 || n > max) return;
    onChange(Math.round(n * 10) / 10);
  };

  const stars = Array.from({ length: 5 }, (_, i) => i + 1);

  return (
    <Box>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <Box role="radiogroup" aria-label={label} sx={{ display: 'flex', alignItems: 'center' }}>
          {stars.map((star) => {
            const filled = value != null && value >= star;
            const half = value != null && value >= star - 0.5 && value < star;
            return (
              <Tooltip key={star} title={`${star} star${star === 1 ? '' : 's'}`}>
                <span>
                  <IconButton
                    size="small"
                    disabled={disabled}
                    aria-label={`Set rating to ${star}`}
                    onClick={() => onChange(star)}
                    sx={{ p: 0.25 }}
                  >
                    {filled ? (
                      <StarIcon sx={{ color: '#C79A4A' }} />
                    ) : half ? (
                      <StarHalfIcon sx={{ color: '#C79A4A' }} />
                    ) : (
                      <StarBorderIcon sx={{ color: '#C79A4A' }} />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            );
          })}
        </Box>
        <TextField
          size="small"
          type="number"
          value={text}
          onChange={(e) => handleText(e.target.value)}
          disabled={disabled}
          placeholder="—"
          slotProps={{
            htmlInput: { min: 0, max, step: 0.1, 'aria-label': label },
            input: {
              endAdornment: <InputAdornment position="end">/ {max}</InputAdornment>,
            },
          }}
          sx={{ width: 130 }}
        />
        {value != null && (
          <Button size="small" disabled={disabled} onClick={() => onChange(null)} sx={{ textTransform: 'none', fontWeight: 700 }}>
            Clear
          </Button>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        {helperText}
      </Typography>
    </Box>
  );
};

export default StarRatingInput;
