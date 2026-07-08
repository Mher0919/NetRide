import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../theme/app_theme.dart';

class TipFab extends StatelessWidget {
  final String rideId;

  const TipFab({super.key, required this.rideId});

  @override
  Widget build(BuildContext context) {
    return FloatingActionButton.extended(
      heroTag: 'tip_fab_${rideId}',
      onPressed: () => _showTipSheet(context),
      backgroundColor: Colors.white,
      foregroundColor: AppTheme.primaryBrandGreen,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(24),
        side: const BorderSide(color: AppTheme.primaryBrandGreen, width: 1.5),
      ),
      elevation: 3,
      icon: const Icon(Icons.attach_money_rounded),
      label: const Text(
        'Add tip',
        style: TextStyle(fontWeight: FontWeight.bold),
      ),
    );
  }

  void _showTipSheet(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (context) => _TipSheet(rideId: rideId),
    );
  }
}

class _TipSheet extends StatefulWidget {
  final String rideId;
  const _TipSheet({required this.rideId});

  @override
  State<_TipSheet> createState() => _TipSheetState();
}

class _TipSheetState extends State<_TipSheet> {
  final TextEditingController _customController = TextEditingController();
  double? _selectedAmount;
  bool _isSubmitting = false;

  void _selectAmount(double amount) {
    setState(() {
      _selectedAmount = amount;
      _customController.clear();
    });
  }

  Future<void> _submit(BuildContext context) async {
    double amount = 0;
    if (_customController.text.isNotEmpty) {
      amount = double.tryParse(_customController.text) ?? 0;
    } else if (_selectedAmount != null) {
      amount = _selectedAmount!;
    }

    if (amount <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select or enter a valid tip amount.')),
      );
      return;
    }

    setState(() => _isSubmitting = true);
    try {
      final rideProvider = Provider.of<RideProvider>(context, listen: false);
      await rideProvider.submitTip(widget.rideId, amount);
      if (mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Tip of \$${amount.toStringAsFixed(2)} sent!')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to send tip: $e')),
        );
        setState(() => _isSubmitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AppTheme.lightCardBackground,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      padding: EdgeInsets.fromLTRB(24, 20, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: AppTheme.softBorderColor,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 20),
          const Text(
            'Support Your Driver',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppTheme.secondaryDarkText,
              fontSize: 20,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            '100% of your tip goes to the driver. You can add a tip now or at the end of the trip.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Colors.grey,
              fontSize: 14,
            ),
          ),
          const SizedBox(height: 24),
          // Quick pick buttons
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [1.0, 3.0, 5.0].map((amt) {
              final isSelected = _selectedAmount == amt && _customController.text.isEmpty;
              return Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: isSelected ? AppTheme.primaryBrandGreen : Colors.white,
                      foregroundColor: isSelected ? Colors.white : AppTheme.secondaryDarkText,
                      elevation: 0,
                      side: BorderSide(
                        color: isSelected ? Colors.transparent : AppTheme.softBorderColor,
                      ),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      padding: const EdgeInsets.symmetric(vertical: 12),
                    ),
                    onPressed: () => _selectAmount(amt),
                    child: Text(
                      '\$${amt.round()}',
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 16),
          // Custom tip input
          TextField(
            controller: _customController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (val) {
              if (val.isNotEmpty) {
                setState(() {
                  _selectedAmount = null;
                });
              }
            },
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.attach_money_rounded, color: AppTheme.primaryBrandGreen),
              hintText: 'Enter custom amount',
              fillColor: Colors.white,
              filled: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: AppTheme.softBorderColor),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: AppTheme.softBorderColor),
              ),
            ),
          ),
          const SizedBox(height: 24),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppTheme.primaryBrandGreen,
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 16),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
            ),
            onPressed: _isSubmitting ? null : () => _submit(context),
            child: _isSubmitting
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                  )
                : const Text('Confirm Tip', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }
}
