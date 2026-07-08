import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Chip, 
  Avatar
} from '@mui/material';
import { 
  DataGrid, 
  type GridColDef, 
  type GridRenderCellParams 
} from '@mui/x-data-grid';
import api from '../api';
import { format } from 'date-fns';

const AuditLogs: React.FC = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [paginationModel, setPaginationModel] = useState({
    page: 0,
    pageSize: 20,
  });

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/logs', {
        params: {
          page: paginationModel.page + 1,
          limit: paginationModel.pageSize
        }
      });
      setLogs(response.data.logs);
      setTotal(response.data.total);
    } catch (error) {
      console.error('Failed to fetch logs', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [paginationModel]);

  const columns: GridColDef[] = [
    { 
      field: 'created_at', 
      headerName: 'Timestamp', 
      width: 220,
      valueFormatter: (params: any) => params.value ? format(new Date(params.value), 'MMM dd, yyyy HH:mm:ss') : '-'
    },
    { 
      field: 'admin', 
      headerName: 'Administrator', 
      flex: 1, 
      minWidth: 180,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Avatar sx={{ width: 28, height: 28, mr: 1.5, fontSize: '0.75rem', bgcolor: 'primary.main', fontWeight: 700 }}>
            {params.value?.full_name?.charAt(0)}
          </Avatar>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{params.value?.full_name}</Typography>
        </Box>
      )
    },
    { 
      field: 'action', 
      headerName: 'Action', 
      width: 140,
      renderCell: (params: GridRenderCellParams) => {
        const action = params.value as string;
        let color: "success" | "error" | "info" | "default" | "warning" = "default";
        if (action.includes('VERIFY') || action.includes('APPROVED')) color = "success";
        if (action.includes('REJECT')) color = "error";
        if (action.includes('PENDING')) color = "warning";
        if (action.includes('INSPECTION')) color = "info";
        
        return (
          <Chip 
            label={action.replace('_', ' ')} 
            color={color as any} 
            size="small" 
            sx={{ fontWeight: 800, fontSize: '0.65rem', height: 22 }} 
          />
        );
      }
    },
    { 
      field: 'target', 
      headerName: 'Target Identity', 
      flex: 1.2, 
      minWidth: 200,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{params.value?.full_name}</Typography>
          <Typography variant="caption" color="text.secondary">{params.value?.email}</Typography>
        </Box>
      )
    },
    { 
      field: 'details', 
      headerName: 'Event Details', 
      flex: 2, 
      minWidth: 300,
      renderCell: (params: GridRenderCellParams) => (
        <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 500 }}>
          {params.value}
        </Typography>
      )
    }
  ];

  return (
    <Box>
      <Box sx={{ mb: 5 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, mb: 1 }}>Security Audit</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
          Immutable log of all administrative actions and system modifications
        </Typography>
      </Box>

      <Paper sx={{ height: 800, width: '100%', border: 'none', overflow: 'hidden' }}>
        <DataGrid
          rows={logs}
          columns={columns}
          paginationMode="server"
          rowCount={total}
          loading={loading}
          paginationModel={paginationModel}
          onPaginationModelChange={setPaginationModel}
          pageSizeOptions={[20, 50, 100]}
          disableRowSelectionOnClick
          sx={{ 
            border: 'none',
            '& .MuiDataGrid-columnHeaders': {
              bgcolor: '#fafafa',
              borderBottom: '1px solid rgba(0,0,0,0.05)'
            },
            '& .MuiDataGrid-cell': {
              borderBottom: '1px solid rgba(0,0,0,0.03)'
            }
          }}
        />
      </Paper>
    </Box>
  );
};

export default AuditLogs;
