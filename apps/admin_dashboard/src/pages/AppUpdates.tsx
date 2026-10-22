import React from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import {
  deactivateAppUpdate,
  discardAppUpdateDraft,
  getAppUpdateHistory,
  listAppUpdateConfigs,
  publishAppUpdate,
  saveAppUpdateDraft,
  type AppUpdateConfig,
  type AppUpdateHistoryEvent,
} from '../api/admin';
import {
  ACCENT_OPTIONS,
  APP_LABELS,
  APP_UPDATE_LIMITS,
  HISTORY_ACTION_LABELS,
  PLATFORM_LABELS,
  formFromConfig,
  historySummary,
  toDraftPayload,
  validateAppUpdateForm,
  type AppUpdateFormValues,
} from '../utils/appUpdates';
import UpdatePopupPreview, {
  type PreviewDevice,
} from '../components/UpdatePopupPreview';

type ConfirmKind = 'publish' | 'deactivate' | 'discard';

const emptyForm: AppUpdateFormValues = {
  campaignName: '',
  latestVersion: '1.0.0',
  minimumVersion: '1.0.0',
  latestBuild: null,
  minimumBuild: null,
  storeUrl: '',
  popupTitle: 'Update required',
  popupMessage:
    'A required update is ready. Please update to the latest version to continue using NetRide.',
  buttonText: 'Update Now',
  supportingText: '',
  announcementLabel: '',
  accentColor: null,
};

const errorMessage = (error: unknown, fallback: string) => {
  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: { data?: { error?: string } } })
      .response;
    if (response?.data?.error) return response.data.error;
  }
  return fallback;
};

const statusChip = (config: AppUpdateConfig) => {
  if (config.published.campaignStatus === 'PUBLISHED' && config.published.isActive) {
    return <Chip size="small" color="success" label="Published" />;
  }
  if (config.published.campaignStatus === 'DISABLED' || !config.published.isActive) {
    return <Chip size="small" label="Disabled" />;
  }
  return <Chip size="small" color="warning" label="Draft only" />;
};

const fmtDate = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const AppUpdates: React.FC = () => {
  const [configs, setConfigs] = React.useState<AppUpdateConfig[]>([]);
  const [selectedKey, setSelectedKey] = React.useState('rider:android');
  const selectedKeyRef = React.useRef(selectedKey);
  const [form, setForm] = React.useState<AppUpdateFormValues>(emptyForm);
  const [baseline, setBaseline] = React.useState(JSON.stringify(emptyForm));
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [showErrors, setShowErrors] = React.useState(false);
  const [device, setDevice] = React.useState<PreviewDevice>('standard');
  const [history, setHistory] = React.useState<AppUpdateHistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [confirm, setConfirm] = React.useState<ConfirmKind | null>(null);
  const [confirmAck, setConfirmAck] = React.useState(false);
  const [deactivateReason, setDeactivateReason] = React.useState('');
  const [snack, setSnack] = React.useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error';
  }>({ open: false, message: '', severity: 'success' });

  const selected = React.useMemo(
    () => configs.find(item => `${item.app}:${item.platform}` === selectedKey),
    [configs, selectedKey],
  );

  const errors = React.useMemo(
    () =>
      selected
        ? validateAppUpdateForm(form, selected.app, selected.platform)
        : {},
    [form, selected],
  );
  const isDirty = JSON.stringify(form) !== baseline;

  const applyConfig = React.useCallback((config: AppUpdateConfig) => {
    const nextForm = formFromConfig(config);
    setForm(nextForm);
    setBaseline(JSON.stringify(nextForm));
    setShowErrors(false);
  }, []);

  const loadHistory = React.useCallback(async (config: AppUpdateConfig) => {
    setHistoryLoading(true);
    try {
      const data = await getAppUpdateHistory(config.app, config.platform);
      setHistory(data.events);
    } catch (error) {
      console.error('Failed to load app update history', error);
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadConfigs = React.useCallback(
    async (preferredKey?: string) => {
      try {
        setLoadError('');
        const data = await listAppUpdateConfigs();
        setConfigs(data.configs);
        const targetKey = preferredKey ?? selectedKeyRef.current;
        const target =
          data.configs.find(
            item => `${item.app}:${item.platform}` === targetKey,
          ) ?? data.configs[0];
        if (!target) {
          setLoadError('No app update configurations were returned.');
          return;
        }
        const key = `${target.app}:${target.platform}`;
        selectedKeyRef.current = key;
        setSelectedKey(key);
        applyConfig(target);
        await loadHistory(target);
      } catch (error) {
        setLoadError(
          errorMessage(error, 'Failed to load app update settings.'),
        );
      } finally {
        setLoading(false);
      }
    },
    [applyConfig, loadHistory],
  );

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfigs();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConfigs]);

  const replaceConfig = React.useCallback(
    (config: AppUpdateConfig) => {
      setConfigs(current =>
        current.map(item =>
          item.app === config.app && item.platform === config.platform
            ? config
            : item,
        ),
      );
      const key = `${config.app}:${config.platform}`;
      selectedKeyRef.current = key;
      setSelectedKey(key);
      applyConfig(config);
    },
    [applyConfig],
  );

  const updateField = <K extends keyof AppUpdateFormValues>(
    key: K,
    value: AppUpdateFormValues[K],
  ) => {
    setForm(current => ({ ...current, [key]: value }));
  };

  const handleSelectTarget = (value: string) => {
    if (value === selectedKey) return;
    if (isDirty && !window.confirm('Discard unsaved changes and switch apps?')) {
      return;
    }
    const target = configs.find(
      item => `${item.app}:${item.platform}` === value,
    );
    if (!target) return;
    selectedKeyRef.current = value;
    setSelectedKey(value);
    applyConfig(target);
    void loadHistory(target);
  };

  const handleRefresh = async () => {
    setLoading(true);
    await loadConfigs(selectedKeyRef.current);
  };

  const handleSaveDraft = async () => {
    if (!selected) return;
    setShowErrors(true);
    if (Object.keys(errors).length > 0) {
      setSnack({
        open: true,
        message: 'Fix the highlighted fields before saving the draft.',
        severity: 'error',
      });
      return;
    }

    setSaving(true);
    try {
      const data = await saveAppUpdateDraft(
        selected.app,
        selected.platform,
        {
          ...toDraftPayload(form),
          expectedRevision: selected.draftRevision,
        },
      );
      replaceConfig(data.config);
      setSnack({
        open: true,
        message: 'Draft saved. Published users are unchanged.',
        severity: 'success',
      });
      await loadHistory(data.config);
    } catch (error) {
      setSnack({
        open: true,
        message: errorMessage(error, 'Failed to save the draft.'),
        severity: 'error',
      });
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { response?: { status?: number } }).response?.status === 409
      ) {
        void loadConfigs(selectedKeyRef.current);
      }
    } finally {
      setSaving(false);
    }
  };

  const runConfirmedAction = async () => {
    if (!selected || !confirm) return;
    setSaving(true);
    try {
      let data;
      if (confirm === 'publish') {
        data = await publishAppUpdate(
          selected.app,
          selected.platform,
          selected.draftRevision,
        );
      } else if (confirm === 'deactivate') {
        data = await deactivateAppUpdate(
          selected.app,
          selected.platform,
          selected.draftRevision,
          deactivateReason.trim() || undefined,
        );
      } else {
        data = await discardAppUpdateDraft(
          selected.app,
          selected.platform,
          selected.draftRevision,
        );
      }
      replaceConfig(data.config);
      await loadHistory(data.config);
      setSnack({
        open: true,
        message:
          confirm === 'publish'
            ? 'Update campaign published globally.'
            : confirm === 'deactivate'
              ? 'Update campaign deactivated.'
              : 'Draft discarded.',
        severity: 'success',
      });
      setConfirm(null);
      setConfirmAck(false);
      setDeactivateReason('');
    } catch (error) {
      setSnack({
        open: true,
        message: errorMessage(error, 'The action could not be completed.'),
        severity: 'error',
      });
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { response?: { status?: number } }).response?.status === 409
      ) {
        setConfirm(null);
        void loadConfigs(selectedKeyRef.current);
      }
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (key: string) => (showErrors ? errors[key] : undefined);
  const counter = (value: string, max: number) =>
    `${value.trim().length}/${max}`;

  const publishDisabledReason = !selected
    ? 'Select an app and platform.'
    : !selected.draft
      ? 'Save a draft before publishing.'
      : isDirty
        ? 'Save your changes to the draft before publishing.'
        : Object.keys(errors).length > 0
          ? 'Fix validation errors before publishing.'
          : '';

  if (!selected) {
    return (
      <Box sx={{ py: 8, textAlign: 'center' }}>
        {loading ? (
          <CircularProgress />
        ) : (
          <Typography color="text.secondary">
            {loadError || 'No app update configurations found.'}
          </Typography>
        )}
      </Box>
    );
  }

  return (
    <Box>
      <Stack
        direction="row"
        sx={{
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 2,
        }}
      >
        <Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <SystemUpdateAltIcon sx={{ color: 'secondary.main' }} />
            <Typography
              variant="h5"
              sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}
            >
              Update Management
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Draft, preview, and publish the mandatory update popup for the
            Rider and Driver applications.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={() => {
            setLoading(true);
            void handleRefresh();
          }}
          disabled={loading || saving}
        >
          Refresh
        </Button>
      </Stack>

      <Alert severity="warning" sx={{ mt: 3 }}>
        Publishing blocks every eligible user below the minimum supported
        version, not just this device. Saving a draft never changes what users
        see.
      </Alert>

      {loadError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {loadError}
        </Alert>
      )}

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ mt: 3, alignItems: { md: 'center' } }}
      >
        <TextField
          select
          size="small"
          label="Application"
          value={selected.app}
          onChange={event =>
            handleSelectTarget(`${event.target.value}:${selected.platform}`)
          }
          sx={{ minWidth: 180 }}
        >
          {(['rider', 'driver'] as const).map(app => (
            <MenuItem key={app} value={app}>
              {APP_LABELS[app]}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Platform"
          value={selected.platform}
          onChange={event =>
            handleSelectTarget(`${selected.app}:${event.target.value}`)
          }
          sx={{ minWidth: 160 }}
        >
          {(['android', 'ios'] as const).map(platform => (
            <MenuItem key={platform} value={platform}>
              {PLATFORM_LABELS[platform]}
            </MenuItem>
          ))}
        </TextField>
        {statusChip(selected)}
        {selected.draft && (
          <Chip size="small" color="info" label="Unpublished draft" />
        )}
        <Typography variant="caption" color="text.secondary">
          Draft revision {selected.draftRevision}
        </Typography>
      </Stack>

      <Box
        sx={{
          mt: 3,
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            xl: 'minmax(0, 1.25fr) minmax(360px, 0.75fr)',
          },
          gap: 3,
          alignItems: 'start',
        }}
      >
        <Paper
          sx={{
            p: { xs: 2, sm: 3 },
            borderRadius: '16px',
            boxShadow: 'none',
            border: '1px solid rgba(0,0,0,0.06)',
          }}
        >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            sx={{ justifyContent: 'space-between', gap: 2 }}
          >
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                {selected.draft ? 'Draft campaign' : 'Published campaign'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {selected.draft
                  ? `Editing draft · ${APP_LABELS[selected.app]} ${PLATFORM_LABELS[selected.platform]}`
                  : selected.published.campaignName ||
                    'No campaign label configured'}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              <Chip
                size="small"
                label={`Live min: ${selected.published.minimumVersion}`}
              />
              <Chip
                size="small"
                label={`Live latest: ${selected.published.latestVersion}`}
              />
              <Chip
                size="small"
                label={`Published: ${fmtDate(selected.published.publishedAt)}`}
              />
            </Stack>
          </Stack>

          <Divider sx={{ my: 2.5 }} />

          <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1.5 }}>
            Release targeting
          </Typography>
          <Stack spacing={2}>
            <TextField
              label="Campaign name"
              value={form.campaignName}
              onChange={event => updateField('campaignName', event.target.value)}
              fullWidth
              error={Boolean(fieldError('campaignName'))}
              helperText={
                fieldError('campaignName') ||
                'Internal label only. Never shown to users.'
              }
              inputProps={{ maxLength: APP_UPDATE_LIMITS.campaignName }}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Latest available version"
                placeholder="2.1.0"
                value={form.latestVersion}
                onChange={event =>
                  updateField('latestVersion', event.target.value)
                }
                fullWidth
                error={Boolean(fieldError('latestVersion'))}
                helperText={
                  fieldError('latestVersion') ||
                  'Informational: shown in the version chip.'
                }
              />
              <TextField
                label="Minimum supported version"
                placeholder="2.0.0"
                value={form.minimumVersion}
                onChange={event =>
                  updateField('minimumVersion', event.target.value)
                }
                fullWidth
                error={Boolean(fieldError('minimumVersion'))}
                helperText={
                  fieldError('minimumVersion') ||
                  'Authoritative cutoff. Users below this are blocked.'
                }
              />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Latest build"
                placeholder="42"
                value={form.latestBuild === null ? '' : String(form.latestBuild)}
                onChange={event =>
                  updateField(
                    'latestBuild',
                    event.target.value === '' ? null : Number(event.target.value),
                  )
                }
                fullWidth
                error={Boolean(fieldError('latestBuild'))}
                helperText={fieldError('latestBuild') || 'Optional.'}
                inputProps={{ inputMode: 'numeric' }}
              />
              <TextField
                label="Minimum build"
                placeholder="40"
                value={
                  form.minimumBuild === null ? '' : String(form.minimumBuild)
                }
                onChange={event =>
                  updateField(
                    'minimumBuild',
                    event.target.value === '' ? null : Number(event.target.value),
                  )
                }
                fullWidth
                error={Boolean(fieldError('minimumBuild'))}
                helperText={fieldError('minimumBuild') || 'Optional.'}
                inputProps={{ inputMode: 'numeric' }}
              />
            </Stack>
            <TextField
              label="App store URL"
              value={form.storeUrl}
              onChange={event => updateField('storeUrl', event.target.value)}
              fullWidth
              error={Boolean(fieldError('storeUrl'))}
              helperText={
                fieldError('storeUrl') ||
                'The update button always uses this canonical listing.'
              }
            />
          </Stack>

          <Divider sx={{ my: 2.5 }} />

          <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1.5 }}>
            Popup content
          </Typography>
          <Stack spacing={2}>
            <TextField
              label="Popup title"
              value={form.popupTitle}
              onChange={event => updateField('popupTitle', event.target.value)}
              fullWidth
              required
              error={Boolean(fieldError('popupTitle'))}
              helperText={fieldError('popupTitle') || counter(form.popupTitle, APP_UPDATE_LIMITS.title)}
              inputProps={{ maxLength: APP_UPDATE_LIMITS.title }}
            />
            <TextField
              label="Popup message"
              value={form.popupMessage}
              onChange={event => updateField('popupMessage', event.target.value)}
              fullWidth
              required
              multiline
              minRows={3}
              error={Boolean(fieldError('popupMessage'))}
              helperText={fieldError('popupMessage') || counter(form.popupMessage, APP_UPDATE_LIMITS.message)}
              inputProps={{ maxLength: APP_UPDATE_LIMITS.message }}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Update button text"
                value={form.buttonText}
                onChange={event => updateField('buttonText', event.target.value)}
                fullWidth
                required
                error={Boolean(fieldError('buttonText'))}
                helperText={fieldError('buttonText') || counter(form.buttonText, APP_UPDATE_LIMITS.buttonText)}
                inputProps={{ maxLength: APP_UPDATE_LIMITS.buttonText }}
              />
              <TextField
                label="Announcement label"
                placeholder="IMPORTANT UPDATE"
                value={form.announcementLabel}
                onChange={event =>
                  updateField('announcementLabel', event.target.value)
                }
                fullWidth
                error={Boolean(fieldError('announcementLabel'))}
                helperText={fieldError('announcementLabel') || 'Optional badge above the title.'}
                inputProps={{ maxLength: APP_UPDATE_LIMITS.announcementLabel }}
              />
            </Stack>
            <TextField
              label="Supporting text"
              value={form.supportingText}
              onChange={event =>
                updateField('supportingText', event.target.value)
              }
              fullWidth
              multiline
              minRows={2}
              error={Boolean(fieldError('supportingText'))}
              helperText={fieldError('supportingText') || 'Optional explanation shown in a card below the message.'}
              inputProps={{ maxLength: APP_UPDATE_LIMITS.supportingText }}
            />
            <TextField
              select
              label="Visual accent"
              value={form.accentColor ?? ''}
              onChange={event =>
                updateField('accentColor', event.target.value || null)
              }
              fullWidth
              helperText="Restricted to NetRide-compatible, accessible colors."
            >
              {ACCENT_OPTIONS.map(option => (
                <MenuItem key={option.value ?? 'default'} value={option.value ?? ''}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Box
                      sx={{
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        bgcolor: option.color,
                      }}
                    />
                    <span>{option.label}</span>
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          {isDirty && (
            <Alert severity="info" sx={{ mt: 2.5 }}>
              Unsaved preview changes. Save the draft to persist them. Nothing
              is visible to users until publishing.
            </Alert>
          )}

          <Divider sx={{ my: 2.5 }} />

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{ flexWrap: 'wrap' }}
          >
            <Button
              variant="contained"
              onClick={handleSaveDraft}
              disabled={saving || loading}
              sx={{ bgcolor: 'secondary.main' }}
            >
              {saving ? 'Saving…' : 'Save draft'}
            </Button>
            <Tooltip title={publishDisabledReason}>
              <span>
                <Button
                  variant="contained"
                  color="error"
                  disabled={Boolean(publishDisabledReason) || saving}
                  onClick={() => {
                    setConfirmAck(false);
                    setConfirm('publish');
                  }}
                >
                  Publish update
                </Button>
              </span>
            </Tooltip>
            <Button
              variant="outlined"
              disabled={!selected.draft || saving}
              onClick={() => setConfirm('discard')}
            >
              Discard draft
            </Button>
            <Box sx={{ flex: 1 }} />
            <Button
              variant="text"
              color="error"
              disabled={
                selected.published.campaignStatus !== 'PUBLISHED' || saving
              }
              onClick={() => {
                setDeactivateReason('');
                setConfirm('deactivate');
              }}
            >
              Deactivate campaign
            </Button>
          </Stack>
        </Paper>

        <Stack spacing={3}>
          <Paper
            sx={{
              p: 2,
              borderRadius: '16px',
              boxShadow: 'none',
              border: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            <Stack
              direction="row"
              sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
            >
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                  Popup preview
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Uses the current form values. Never publishes.
                </Typography>
              </Box>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={device}
                onChange={(_event, value) => {
                  if (value) setDevice(value as PreviewDevice);
                }}
              >
                <ToggleButton value="small">S</ToggleButton>
                <ToggleButton value="standard">M</ToggleButton>
                <ToggleButton value="large">L</ToggleButton>
              </ToggleButtonGroup>
            </Stack>
            <UpdatePopupPreview values={form} device={device} />
          </Paper>

          <Paper
            sx={{
              p: 2,
              borderRadius: '16px',
              boxShadow: 'none',
              border: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
              Campaign history
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Authorized admin actions recorded by the backend.
            </Typography>
            <Stack spacing={1.5} sx={{ mt: 2 }}>
              {historyLoading && <CircularProgress size={22} />}
              {!historyLoading && history.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  No campaign history yet.
                </Typography>
              )}
              {!historyLoading &&
                history.map(event => (
                  <Box key={event.id}>
                    <Stack
                      direction="row"
                      sx={{ justifyContent: 'space-between', gap: 1 }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        {HISTORY_ACTION_LABELS[event.action] ?? event.action}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {fmtDate(event.createdAt)}
                      </Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {event.actorName || event.actorEmail || 'System'}
                      {historySummary(event)
                        ? ` · ${historySummary(event)}`
                        : ''}
                    </Typography>
                  </Box>
                ))}
            </Stack>
          </Paper>
        </Stack>
      </Box>

      <Dialog
        open={Boolean(confirm)}
        onClose={() => {
          if (!saving) setConfirm(null);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle sx={{ fontWeight: 800 }}>
          {confirm === 'publish'
            ? 'Publish this mandatory update?'
            : confirm === 'deactivate'
              ? 'Deactivate this update campaign?'
              : 'Discard this draft?'}
        </DialogTitle>
        <DialogContent dividers>
          {confirm === 'publish' && (
            <Stack spacing={2}>
              <Alert severity="warning">
                This affects every eligible user, not only this device. Users
                below version <strong>{selected.draft?.minimumVersion}</strong> on{' '}
                <strong>
                  {APP_LABELS[selected.app]} {PLATFORM_LABELS[selected.platform]}
                </strong>{' '}
                will be blocked immediately after their next policy check.
              </Alert>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Title
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {selected.draft?.popupTitle}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Message
                </Typography>
                <Typography variant="body2">
                  {selected.draft?.popupMessage}
                </Typography>
              </Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Latest version
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {selected.draft?.latestVersion}
                  </Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Minimum version
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {selected.draft?.minimumVersion}
                  </Typography>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Store
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {PLATFORM_LABELS[selected.platform]}
                  </Typography>
                </Box>
              </Stack>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={confirmAck}
                    onChange={event => setConfirmAck(event.target.checked)}
                  />
                }
                label="I understand this publication applies globally to eligible users."
              />
            </Stack>
          )}
          {confirm === 'deactivate' && (
            <Stack spacing={2}>
              <Alert severity="warning">
                Deactivating stops mandatory update enforcement for this app and
                platform. Unsupported users will no longer be blocked.
              </Alert>
              <TextField
                label="Reason (optional)"
                value={deactivateReason}
                onChange={event => setDeactivateReason(event.target.value)}
                multiline
                minRows={2}
                fullWidth
                inputProps={{ maxLength: 300 }}
              />
            </Stack>
          )}
          {confirm === 'discard' && (
            <Typography variant="body2">
              This deletes the unpublished draft. The currently published
              campaign remains unchanged.
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            color="inherit"
            onClick={() => setConfirm(null)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color={confirm === 'publish' ? 'error' : 'primary'}
            onClick={runConfirmedAction}
            disabled={
              saving ||
              (confirm === 'publish' && !confirmAck)
            }
          >
            {saving
              ? 'Working…'
              : confirm === 'publish'
                ? 'Publish globally'
                : confirm === 'deactivate'
                  ? 'Deactivate'
                  : 'Discard draft'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack.open}
        autoHideDuration={6000}
        onClose={() => setSnack(current => ({ ...current, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={snack.severity}
          onClose={() => setSnack(current => ({ ...current, open: false }))}
        >
          {snack.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default AppUpdates;
