import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Chip, 
  IconButton,
  TextField,
  InputAdornment
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
import { format } from 'date-fns';

interface UserTableProps {
  role: 'RIDER' | 'DRIVER';
  title: string;
}

const UserTable: React.FC<UserTableProps> = ({ role, title }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [paginationModel, setPaginationModel] = useState({
    page: 0,
    pageSize: 10,
  });
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/users', {
        params: {
          role,
          search,
          page: paginationModel.page + 1,
          limit: paginationModel.pageSize
        }
      });
      setUsers(response.data.users);
      setTotal(response.data.total);
    } catch (error) {
      console.error('Failed to fetch users', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [role, paginationModel, search]);

  const columns: GridColDef[] = [
    { field: 'full_name', headerName: 'Name', flex: 1, minWidth: 150 },
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
      ? [{
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
        }]
      : []),
    {
      field: 'created_at',
      headerName: 'Registered',
      width: 150,
      valueFormatter: (params: any) => params.value ? format(new Date(params.value), 'MMM dd, yyyy') : '-'
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 100,
      sortable: false,
      renderCell: (params: GridRenderCellParams) => (
        <IconButton onClick={() => navigate(`/users/${params.row.id}`)}>
          <ViewIcon fontSize="small" />
        </IconButton>
      )
    }
  ];

  return (
    <Box sx={{ maxWidth: 1600, mx: 'auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 5 }}>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>{title}</Typography>
        <TextField
          size="small"
          placeholder="Search identity or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          {...({
            InputProps: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                </InputAdornment>
              ),
              sx: { borderRadius: '12px', bgcolor: 'white', px: 1 }
            }
          } as any)}
          sx={{ width: 350 }}
        />
      </Box>

      <Paper sx={{ height: 750, width: '100%', border: 'none', overflow: 'hidden' }}>
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
              fontWeight: 800
            },
            '& .MuiDataGrid-cell': {
              borderBottom: '1px solid rgba(0,0,0,0.03)',
              py: 2
            }
          }}
        />
      </Paper>
    </Box>
  );
};

export default UserTable;
