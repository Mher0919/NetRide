import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../models/trip_models.dart' as models;

class RatingScreen extends StatefulWidget {
  final models.Trip trip;
  const RatingScreen({super.key, required this.trip});

  @override
  State<RatingScreen> createState() => _RatingScreenState();
}

class _RatingScreenState extends State<RatingScreen> {
  int _selectedRating = 5;
  double _tipAmount = 0.0;
  bool _isFavorite = false;
  bool _isSubmitting = false;
  final _commentController = TextEditingController();

  void _submit() async {
    setState(() => _isSubmitting = true);
    final rideProvider = Provider.of<RideProvider>(context, listen: false);
    try {
      // 1. Submit Tip if any
      if (_tipAmount > 0) {
        await rideProvider.submitTip(widget.trip.id, _tipAmount);
      }
      
      // 2. Submit Rating and Favorite choice
      await rideProvider.rateRide(
        widget.trip.id, 
        _selectedRating, 
        _commentController.text.trim(),
        favorite: _isFavorite
      );

      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Thank you for your feedback!')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed to submit: $e')));
        setState(() => _isSubmitting = false);
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
        automaticallyImplyLeading: false,
        actions: [
          IconButton(
            icon: const Icon(Icons.close, color: Colors.black),
            onPressed: () => Navigator.pop(context),
          )
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: Column(
          children: [
            const CircleAvatar(
              radius: 40,
              backgroundColor: Color(0xFFF7F4EF),
              child: Icon(Icons.person, size: 40, color: Color(0xFF5B7760)),
            ),
            const SizedBox(height: 16),
            Text(
              'How was your ride with ${widget.trip.driverInfo?.name ?? 'your driver'}?',
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 32),
            
            // Rating Stars
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(5, (index) {
                return IconButton(
                  icon: Icon(
                    index < _selectedRating ? Icons.star_rounded : Icons.star_outline_rounded,
                    color: const Color(0xFFC79A4A),
                    size: 42,
                  ),
                  onPressed: () => setState(() => _selectedRating = index + 1),
                );
              }),
            ),
            const SizedBox(height: 48),

            // Tipping Section
            Align(
              alignment: Alignment.centerLeft,
              child: Text('Add a Tip', style: GoogleFonts.poppins(fontWeight: FontWeight.w700, fontSize: 14)),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [0.0, 1.0, 3.0, 5.0].map((amount) {
                final isSelected = _tipAmount == amount;
                return GestureDetector(
                  onTap: () => setState(() => _tipAmount = amount),
                  child: Container(
                    width: 70,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    decoration: BoxDecoration(
                      color: isSelected ? Colors.black : Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: isSelected ? Colors.black : Colors.grey.shade300),
                    ),
                    child: Text(
                      amount == 0 ? 'No Tip' : '\$${amount.toInt()}',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: isSelected ? Colors.white : Colors.black,
                        fontWeight: FontWeight.w700,
                        fontSize: 13
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 48),

            // Favorite Toggle
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: _isFavorite ? const Color(0xFF5B7760).withOpacity(0.05) : Colors.transparent,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: _isFavorite ? const Color(0xFF5B7760) : Colors.grey.shade200),
              ),
              child: Row(
                children: [
                  Icon(
                    _isFavorite ? Icons.favorite_rounded : Icons.favorite_outline_rounded,
                    color: _isFavorite ? const Color(0xFFC65A5A) : Colors.grey,
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Add to Favorites', style: GoogleFonts.poppins(fontWeight: FontWeight.w700, fontSize: 14)),
                        Text('Prioritize this driver for future trips.', style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                      ],
                    ),
                  ),
                  Switch(
                    value: _isFavorite,
                    onChanged: (val) => setState(() => _isFavorite = val),
                    activeThumbColor: const Color(0xFF5B7760),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),

            TextField(
              controller: _commentController,
              maxLines: 3,
              decoration: InputDecoration(
                hintText: 'Add a comment (optional)',
                filled: true,
                fillColor: Colors.grey.shade50,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
              ),
            ),
            const SizedBox(height: 48),
            
            SizedBox(
              width: double.infinity,
              height: 56,
              child: ElevatedButton(
                onPressed: _isSubmitting ? null : _submit,
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.black,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: _isSubmitting 
                  ? const CircularProgressIndicator(color: Colors.white)
                  : const Text('COMPLETE & SUBMIT', style: TextStyle(fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
