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
        title: Text('Earnings & Activity', style: GoogleFonts.poppins(color: Colors.black, fontWeight: FontWeight.bold)),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator(color: Colors.black))
          : _history.isEmpty
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
    );
  }

  Widget _buildEarningsSummary() {
    double total = 0;
    for (var ride in _history) {
      total += double.tryParse(ride['estimated_fare']?.toString() ?? '0') ?? 0;
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
          Text('${_history.length} completed trips', style: GoogleFonts.poppins(color: Colors.greenAccent, fontSize: 12, fontWeight: FontWeight.w600)),
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
    final date = DateTime.parse(ride['created_at']);
    final formattedDate = DateFormat('MMM d, h:mm a').format(date);
    final fare = ride['estimated_fare'] ?? '0.00';
    final rating = ride['rating'];

    return Container(
      margin: const EdgeInsets.bottom(16),
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
              Text('+\$$fare', style: GoogleFonts.poppins(fontWeight: FontWeight.bold, color: Colors.green[700])),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              const Icon(Icons.circle, size: 8, color: Colors.grey),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  ride['pickup_address'] ?? 'Pickup',
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
                  ride['destination_address'] ?? 'Destination',
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
