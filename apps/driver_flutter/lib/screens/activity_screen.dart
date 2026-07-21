import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';
import '../components/state_container.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  List<dynamic> _history = [];
  bool _isDeleting = false;

  @override
  void initState() {
    super.initState();
    _fetchHistory();
  }

  Future<void> _fetchHistory() async {
    setState(() => _state = ViewState.loading);
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('jwt_token');
      if (token == null) {
        setState(() {
          _history = [];
          _state = ViewState.success;
        });
        return;
      }

      final response = await ApiService.dio.get('/ride/history');
      setState(() {
        _history = response.data;
        _state = ViewState.success;
      });
    } catch (e) {
      setState(() {
        _state = ViewState.failure;
        _errorMessage = 'Unable to synchronize your driving data. Please check your connection.';
      });
    }
  }

  Future<void> _deleteActivity(String id) async {
    setState(() => _isDeleting = true);
    try {
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
    } finally {
      if (mounted) setState(() => _isDeleting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFEEEBE6),
      appBar: AppBar(
        backgroundColor: const Color(0xFFEEEBE6),
        elevation: 0,
        title: Text('Earnings & Activity', style: GoogleFonts.poppins(color: Colors.black, fontWeight: FontWeight.bold)),
      ),
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _fetchHistory,
        successWidget: _history.isEmpty
            ? _buildEmptyState()
            : Column(
                children: [
                  _buildEarningsSummary(),
                  Expanded(
                    child: ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _history.length,
                      itemBuilder: (context, index) {
                        final ride = _history[index];
                        return _buildRideCard(ride);
                      },
                    ),
                  ),
                ],
              ),
      ),
    );
  }

  Widget _buildEarningsSummary() {
    final completed = _history.where((r) => r['status'] == 'COMPLETED').toList();
    double total = 0;
    for (var ride in completed) {
      total += double.tryParse((ride['fare_amount'] ?? ride['estimated_fare'] ?? '0').toString()) ?? 0;
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.all(16),
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: Colors.black,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Total Earnings', style: GoogleFonts.poppins(color: Colors.grey, fontSize: 14)),
          const SizedBox(height: 8),
          Text('\$${total.toStringAsFixed(2)}', style: GoogleFonts.poppins(color: Colors.white, fontSize: 32, fontWeight: FontWeight.bold)),
          const SizedBox(height: 16),
          Text('${completed.length} completed trips', style: GoogleFonts.poppins(color: Colors.greenAccent, fontSize: 12, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.history, size: 80, color: Colors.grey[300]),
          const SizedBox(height: 16),
          Text(
            'No trips completed yet',
            style: GoogleFonts.poppins(fontSize: 18, color: Colors.grey, fontWeight: FontWeight.w500),
          ),
        ],
      ),
    );
  }

  Widget _buildRideCard(dynamic ride) {
    final dateStr = ride['requested_at'] ?? ride['created_at'];
    final date = dateStr != null ? DateTime.parse(dateStr.toString()) : DateTime.now();
    final formattedDate = DateFormat('MMM d, h:mm a').format(date);
    final rating = ride['rating'];
    final status = ride['status'] ?? 'UNKNOWN';

    dynamic fare = ride['fare_amount'] ?? ride['estimated_fare'] ?? '0.00';
    Color fareColor;
    String farePrefix;
    if (status == 'COMPLETED') {
      fareColor = Colors.green[700]!;
      farePrefix = '+\$';
    } else if (status == 'CANCELLED') {
      fareColor = Colors.red[400]!;
      farePrefix = '';
      fare = '0.00';
    } else {
      fareColor = Colors.grey[600]!;
      farePrefix = '\$';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey[200]!),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(formattedDate, style: GoogleFonts.poppins(fontWeight: FontWeight.bold, fontSize: 14)),
              Row(
                children: [
                  Text('$farePrefix$fare', style: GoogleFonts.poppins(fontWeight: FontWeight.bold, color: fareColor)),
                  const SizedBox(width: 8),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: _isDeleting
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.redAccent))
                        : const Icon(Icons.delete_outline, size: 20, color: Colors.redAccent),
                    onPressed: _isDeleting ? null : () => _deleteActivity(ride['id']),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              const Icon(Icons.circle, size: 8, color: Colors.grey),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  ride['pickup']?['address']?.toString() ?? ride['pickup_address']?.toString() ?? 'Pickup',
                  style: GoogleFonts.poppins(fontSize: 12, color: Colors.grey[600]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              const Icon(Icons.square, size: 8, color: Colors.black),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  ride['destination']?['address']?.toString() ?? ride['destination_address']?.toString() ?? 'Destination',
                  style: GoogleFonts.poppins(fontSize: 12, color: Colors.grey[600]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          if (rating != null) ...[
            const Divider(height: 24),
            Row(
              children: [
                Text('Rider rated you: ', style: GoogleFonts.poppins(fontSize: 12, color: Colors.grey)),
                const Spacer(),
                ...List.generate(5, (i) => Icon(
                  Icons.star,
                  size: 14,
                  color: i < rating ? Colors.amber : Colors.grey[300],
                )),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
