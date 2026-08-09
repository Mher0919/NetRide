import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

enum ViewState { loading, success, failure }

class StateContainer extends StatelessWidget {
  final ViewState state;
  final Widget successWidget;
  final String? errorMessage;
  final VoidCallback? onRetry;
  final Widget? loadingWidget;

  const StateContainer({
    super.key,
    required this.state,
    required this.successWidget,
    this.errorMessage,
    this.onRetry,
    this.loadingWidget,
  });

  @override
  Widget build(BuildContext context) {
    switch (state) {
      case ViewState.loading:
        return loadingWidget ?? _buildDefaultLoading();
      case ViewState.failure:
        return _buildDefaultFailure();
      case ViewState.success:
        return successWidget;
    }
  }

  Widget _buildDefaultLoading() {
    return const Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          CircularProgressIndicator(color: Colors.black),
          SizedBox(height: 24),
          Text(
            'Preparing your dashboard...',
            style: TextStyle(
              color: Colors.black,
              fontWeight: FontWeight.w600,
              fontSize: 14,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDefaultFailure() {
    return Padding(
      padding: const EdgeInsets.all(32.0),
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: Colors.red.withOpacity(0.1),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.warning_amber_rounded, size: 48, color: Colors.red),
            ),
            const SizedBox(height: 24),
            Text(
              'Connection Issue',
              style: GoogleFonts.poppins(
                fontSize: 20,
                fontWeight: FontWeight.w700,
                color: Colors.black,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              errorMessage ?? 'We could not synchronize your data. Please check your connection and try again.',
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(
                fontSize: 14,
                color: Colors.grey[700],
              ),
            ),
            const SizedBox(height: 32),
            if (onRetry != null)
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: onRetry,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.black,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 18),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: const Text('RETRY SYNC'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
