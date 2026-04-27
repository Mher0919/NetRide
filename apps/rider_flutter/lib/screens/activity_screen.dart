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
      final response = await ApiService.dio.get('/ride/history');
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        title: Text('Activity', style: GoogleFonts.poppins(color: Colors.black, fontWeight: FontWeight.bold)),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator(color: Colors.black))
          : _history.isEmpty
              ? _buildEmptyState()
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _history.length,
                  itemBuilder: (context, index) {
                    final ride = _history[index];
                    return _buildRideCard(ride);
                  },
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
            'No past trips yet',
            style: GoogleFonts.poppins(fontSize: 18, color: Colors.grey, fontWeight: FontWeight.w500),
          ),
        ],
      ),
    );
  }

  Widget _buildRideCard(dynamic ride) {
    final date = DateTime.parse(ride['created_at']);
    final formattedDate = DateFormat('MMM d, h:mm a').format(date);
    final status = ride['status']?.toString().toUpperCase() ?? 'COMPLETED';
    final fare = ride['estimated_fare'] ?? '0.00';
    final rating = ride['rating'];

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey[200]!),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.02), blurRadius: 10, offset: const Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(formattedDate, style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
              Text('\$$fare', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              const Icon(Icons.location_on, size: 16, color: Colors.grey),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  ride['pickup_address'] ?? 'Unknown Pickup',
                  style: GoogleFonts.poppins(fontSize: 13, color: Colors.grey[600]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              const Icon(Icons.circle, size: 10, color: Colors.black),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  ride['destination_address'] ?? 'Unknown Destination',
                  style: GoogleFonts.poppins(fontSize: 13, color: Colors.grey[600]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const Divider(height: 24),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: status == 'COMPLETED' ? Colors.green[50] : Colors.grey[100],
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  status,
                  style: GoogleFonts.poppins(
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    color: status == 'COMPLETED' ? Colors.green[700] : Colors.grey[700],
                  ),
                ),
              ),
              if (rating != null)
                Row(
                  children: [
                    Text('You rated: ', style: GoogleFonts.poppins(fontSize: 12, color: Colors.grey)),
                    ...List.generate(5, (i) => Icon(
                      Icons.star,
                      size: 14,
                      color: i < rating ? Colors.amber : Colors.grey[300],
                    )),
                  ],
                )
              else if (status == 'COMPLETED')
                Text('Not rated', style: GoogleFonts.poppins(fontSize: 12, color: Colors.grey)),
            ],
          ),
        ],
      ),
    );
  }
}
