import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Chip, 
  IconButton,
  TextField,
  InputAdornment,
  FormControlLabel,
  Switch,
  Alert,
  Button
} from '@mui/material';
import { 
  DataGrid, 
  type GridColDef, 
  type GridRenderCellParams 
} from '@mui/x-data-grid';
import { 
  Search as SearchIcon, 
  Visibility as ViewIcon 
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { SpeedingBadge } from './SpeedingBadge';
import { format } from '../utils/date';

interface UserTableProps {
  role: 'RIDER' | 'DRIVER';
  title: string;
}

const UserTable: React.FC<UserTableProps> = ({ role, title }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [paginationModel, setPaginationModel] = useState({
    page: 0,
    pageSize: 10,
  });
  const [search, setSearch] = useState('');
  const [showTest, setShowTest] = useState(false);
  const navigate = useNavigate();

  const fetchUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/admin/users', {
        params: {
          role,
          search,
          page: paginationModel.page + 1,
          limit: paginationModel.pageSize,
          includeTest: showTest ? 'true' : 'false'
        }
      });
      setUsers(response.data.users);
      setTotal(response.data.total);
    } catch (error) {
      console.error('Failed to fetch users', error);
      setError('We could not load this list. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [role, paginationModel, search, showTest]);

  const columns: GridColDef[] = [
    {
      field: 'full_name',
      headerName: 'Name',
      flex: 1,
      minWidth: 150,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{params.value}</span>
          {params.row?.is_test && (
            <Chip
              label="TEST"
              size="small"
              sx={{ height: 18, fontSize: 10, fontWeight: 800, bgcolor: '#FFF4E5', color: '#B26A00', flexShrink: 0 }}
            />
          )}
        </Box>
      ),
    },
    { field: 'email', headerName: 'Email', flex: 1, minWidth: 200 },
    { field: 'phone_number', headerName: 'Phone', flex: 0.8, minWidth: 120 },
    {
      field: 'verification_status',
      headerName: 'Status',
      width: 130,
      renderCell: (params: GridRenderCellParams) => {
        const status = params.value as string;
        let color: "warning" | "success" | "error" | "default" = "default";
        if (status === 'VERIFIED') color = "success";
        if (status === 'PENDING') color = "warning";
        if (status === 'REJECTED') color = "error";
        return <Chip label={status} color={color} size="small" variant="outlined" />;
      }
    },
    ...(role === 'DRIVER'
      ? [
          {
            field: 'has_pending_document_review',
            headerName: 'Documents',
            width: 140,
            sortable: false,
            filterable: false,
            renderCell: (params: GridRenderCellParams) => {
              const pending = params.value as boolean;
              if (!pending) return null;
              return (
                <Chip
                  label="Action Needed"
                  color="error"
                  size="small"
                  variant="outlined"
                  sx={{ fontWeight: 600, fontSize: 11 }}
                />
              );
            },
          },
          {
            field: 'is_dangerous',
            headerName: 'Safety',
            width: 120,
            sortable: false,
            filterable: false,
            renderCell: (params: GridRenderCellParams) => (
              <SpeedingBadge
                isDangerous={!!params.row?.driver_profile?.is_dangerous}
                driverId={params.row?.id}
                size="sm"
              />
            ),
          },
        ]
      : []),
    {
      field: 'created_at',
      headerName: 'Registered',
      width: 150,
      valueFormatter: (value: any) => (value ? format(new Date(value), 'MMM dd, yyyy') : '-')
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 100,
      sortable: false,
      renderCell: (params: GridRenderCellParams) => (
        <IconButton onClick={() => navigate(`/${role.toLowerCase()}s/users/${params.row.id}`)}>
          <ViewIcon fontSize="small" />
        </IconButton>
      )
    }
  ];

  return (
    <Box sx={{ maxWidth: 1600, mx: 'auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Typography variant="h4">{title}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={showTest}
                onChange={(e) => { setShowTest(e.target.checked); setPaginationModel((m) => ({ ...m, page: 0 })); }}
              />
            }
            label={<Typography variant="body2" color="text.secondary">Show test users</Typography>}
          />
          <TextField
            size="small"
            placeholder="Search identity or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                  </InputAdornment>
                ),
                sx: { borderRadius: '12px', bgcolor: 'white', px: 1 },
              },
            }}
            sx={{ width: { xs: '100%', sm: 350 } }}
          />
        </Box>
      </Box>

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => fetchUsers()}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      <Paper sx={{ height: 'calc(100vh - 240px)', minHeight: 420, width: '100%', border: 'none', overflow: 'hidden' }}>
        <DataGrid
          rows={users}
          columns={columns}
          paginationMode="server"
          rowCount={total}
          loading={loading}
          paginationModel={paginationModel}
          onPaginationModelChange={setPaginationModel}
          pageSizeOptions={[10, 25, 50]}
          disableRowSelectionOnClick
          sx={{
            border: 'none',
            '& .MuiDataGrid-columnHeaders': {
              bgcolor: '#fafafa',
              borderBottom: '1px solid rgba(0,0,0,0.05)',
              fontWeight: 800,
            },
            '& .MuiDataGrid-cell': {
              borderBottom: '1px solid rgba(0,0,0,0.03)',
              py: 2,
            },
            '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
              outline: 'none',
            },
          }}
        />
      </Paper>
    </Box>
  );
};

export default UserTable;
