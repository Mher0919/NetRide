import 'package:flutter/material.dart';
import 'package:confetti/confetti.dart';
import '../theme/app_theme.dart';

class TripCompletedDialog extends StatefulWidget {
  final double fareAmount;
  final double tipAmount;
  final double? initialMaxFare;
  final bool isDriver;
  /// Server-computed 60% driver share in cents. Null on stale payloads —
  /// falls back to the full fare (old pre-split behavior).
  final int? driverEarningsCents;

  const TripCompletedDialog({
    super.key,
    required this.fareAmount,
    this.tipAmount = 0.0,
    this.initialMaxFare,
    required this.isDriver,
    this.driverEarningsCents,
  });

  @override
  State<TripCompletedDialog> createState() => _TripCompletedDialogState();
}

class _TripCompletedDialogState extends State<TripCompletedDialog> {
  late ConfettiController _confettiController;

  @override
  void initState() {
    super.initState();
    _confettiController = ConfettiController(duration: const Duration(seconds: 3));
    _confettiController.play();
  }

  @override
  void dispose() {
    _confettiController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final double driverShare = widget.driverEarningsCents != null
        ? widget.driverEarningsCents! / 100.0
        : widget.fareAmount;
    final double totalEarnings =
        widget.isDriver ? driverShare + widget.tipAmount
            : widget.fareAmount + widget.tipAmount;
    final String title = widget.isDriver ? "You completed the trip!" : "Trip complete!";
    
    String subtitle = "";
    if (widget.isDriver) {
      subtitle = "Earnings: \$${totalEarnings.toStringAsFixed(2)}";
      if (widget.tipAmount > 0) {
        subtitle += " (incl. \$${widget.tipAmount.toStringAsFixed(2)} tip)";
      }
    } else {
      subtitle = "Final fare: \$${widget.fareAmount.toStringAsFixed(2)}";
    }

    final showSavings = !widget.isDriver && 
        widget.initialMaxFare != null && 
        widget.initialMaxFare! > widget.fareAmount;
    final savingsAmount = showSavings ? (widget.initialMaxFare! - widget.fareAmount) : 0.0;

    return PopScope(
      canPop: false,
      child: Stack(
        alignment: Alignment.topCenter,
        children: [
          ModalBarrier(
            color: Colors.black.withOpacity(0.54),
            dismissible: false,
          ),
          Center(
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 32),
              decoration: BoxDecoration(
                color: AppTheme.lightCardBackground,
                borderRadius: BorderRadius.circular(28),
                border: Border.all(color: AppTheme.softBorderColor, width: 1),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.25),
                    blurRadius: 20,
                    offset: const Offset(0, 10),
                  ),
                ],
              ),
              padding: const EdgeInsets.all(28),
              child: Material(
                color: Colors.transparent,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 100,
                      height: 100,
                      decoration: const BoxDecoration(
                        shape: BoxShape.circle,
                        color: AppTheme.primaryBrandGreen,
                      ),
                      child: const Center(
                        child: Icon(
                          Icons.check_rounded,
                          size: 60,
                          color: Colors.white,
                        ),
                      ),
                    ),
                    const SizedBox(height: 24),
                    Text(
                      title,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: AppTheme.secondaryDarkText,
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      subtitle,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: AppTheme.secondaryDarkText,
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    if (showSavings) ...[
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                        decoration: BoxDecoration(
                          color: AppTheme.successGreen.withOpacity(0.15),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppTheme.successGreen.withOpacity(0.3)),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(
                              Icons.savings_outlined,
                              color: AppTheme.primaryBrandGreen,
                              size: 20,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              "You saved \$${savingsAmount.toStringAsFixed(2)}!",
                              style: const TextStyle(
                                color: AppTheme.primaryBrandGreen,
                                fontWeight: FontWeight.bold,
                                fontSize: 14,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: 28),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.primaryBrandGreen,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(16),
                          ),
                          padding: const EdgeInsets.symmetric(vertical: 16),
                        ),
                        onPressed: () {
                          Navigator.of(context).pop();
                        },
                        child: const Text(
                          'OK',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          ConfettiWidget(
            confettiController: _confettiController,
            blastDirectionality: BlastDirectionality.explosive,
            shouldLoop: false,
            colors: const [
              AppTheme.primaryBrandGreen,
              Color(0xFFE5A93B),
              Colors.white,
            ],
          ),
        ],
      ),
    );
  }
}
