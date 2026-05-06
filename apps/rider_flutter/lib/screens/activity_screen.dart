import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import '../services/api_service.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  bool _isLoading = true;
  List<dynamic> _history = [];

  @override
  void initState() {
    super.initState();
    _fetchHistory();
  }

  Future<void> _fetchHistory() async {
    try {
      final response = await ApiService.dio.get('ride/history');
      setState(() {
        _history = response.data;
        _isLoading = false;
      });
    } catch (e) {
      setState(() => _isLoading = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to load activity: $e')),
        );
      }
    }
  }

  Future<void> _deleteActivity(String id) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Activity'),
        content: const Text('Are you sure you want to delete this trip from your history?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    try {
      await ApiService.dio.delete('/ride/history/$id');
      setState(() {
        _history.removeWhere((ride) => ride['id'] == id);
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Activity deleted')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to delete activity: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text(
          'Activity',
          style: theme.textTheme.headlineMedium?.copyWith(fontSize: 24),
        ),
        centerTitle: false,
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _history.isEmpty
              ? _buildEmptyState()
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                  itemCount: _history.length,
                  itemBuilder: (context, index) {
                    final ride = _history[index];
                    return _buildRideCard(ride, theme);
                  },
                ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.all(32),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.5),
              shape: BoxShape.circle,
            ),
            child: Icon(Icons.receipt_long_outlined, size: 48, color: const Color(0xFF2F3A32).withOpacity(0.2)),
          ),
          const SizedBox(height: 24),
          Text(
            'No trips yet',
            style: TextStyle(
              fontSize: 20,
              color: const Color(0xFF2F3A32),
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Your premium journey history will appear here.',
            style: TextStyle(
              fontSize: 14,
              color: const Color(0xFF2F3A32).withOpacity(0.5),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildRideCard(dynamic ride, ThemeData theme) {
    final dateStr = ride['requested_at'] ?? ride['created_at'];
    final date = dateStr != null ? DateTime.parse(dateStr.toString()) : DateTime.now();
    final formattedDate = DateFormat('EEE, MMM d • h:mm a').format(date);
    final status = ride['status']?.toString().toUpperCase() ?? 'COMPLETED';
    final fare = ride['fare_amount'] ?? ride['estimated_fare'] ?? '0.00';
    final rating = ride['rating'];

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFD8D2CA)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.02),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                formattedDate,
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 14,
                  color: Color(0xFF2F3A32),
                ),
              ),
              Row(
                children: [
                  Text(
                    '\$$fare',
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 16,
                      color: Color(0xFF2F3A32),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.delete_outline, size: 20, color: Colors.redAccent),
                    onPressed: () => _deleteActivity(ride['id']),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 20),
          _buildLocationRow(
            icon: Icons.circle,
            iconColor: const Color(0xFF5B7760),
            address: ride['pickup']?['address']?.toString() ?? ride['pickup_address']?.toString() ?? 'Unknown Pickup',
          ),
          const Padding(
            padding: EdgeInsets.only(left: 4, top: 4, bottom: 4),
            child: SizedBox(
              height: 12,
              child: VerticalDivider(width: 1, thickness: 1, color: Color(0xFFD8D2CA)),
            ),
          ),
          _buildLocationRow(
            icon: Icons.square,
            iconColor: const Color(0xFF2F3A32),
            address: ride['destination']?['address']?.toString() ?? ride['destination_address']?.toString() ?? 'Unknown Destination',
          ),
          const SizedBox(height: 20),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: status == 'COMPLETED' 
                      ? const Color(0xFF6E8B74).withOpacity(0.1) 
                      : const Color(0xFF2F3A32).withOpacity(0.05),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  status,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.5,
                    color: status == 'COMPLETED' 
                        ? const Color(0xFF5B7760) 
                        : const Color(0xFF2F3A32).withOpacity(0.6),
                  ),
                ),
              ),
              if (rating != null)
                Row(
                  children: List.generate(5, (i) => Icon(
                    Icons.star,
                    size: 14,
                    color: i < rating ? const Color(0xFFC79A4A) : const Color(0xFFD8D2CA),
                  )),
                )
              else if (status == 'COMPLETED')
                Text(
                  'Rate trip',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: theme.colorScheme.primary,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildLocationRow({required IconData icon, required Color iconColor, required String address}) {
    return Row(
      children: [
        Icon(icon, size: 8, color: iconColor),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            address,
            style: TextStyle(
              fontSize: 13,
              color: const Color(0xFF2F3A32).withOpacity(0.6),
              fontWeight: FontWeight.w500,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}