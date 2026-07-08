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
          CircularProgressIndicator(color: Color(0xFF5B7760)),
          SizedBox(height: 24),
          Text(
            'Initializing premium experience...',
            style: TextStyle(
              color: Color(0xFF2F3A32),
              fontWeight: FontWeight.w500,
              fontSize: 14,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDefaultFailure() {
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: const Color(0xFFC65A5A).withOpacity(0.1),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.error_outline_rounded, size: 48, color: Color(0xFFC65A5A)),
            ),
            const SizedBox(height: 24),
            Text(
              'Something went wrong',
              style: GoogleFonts.poppins(
                fontSize: 20,
                fontWeight: FontWeight.w700,
                color: const Color(0xFF2F3A32),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              errorMessage ?? 'We encountered an issue while processing your request. Please try again.',
              textAlign: TextAlign.center,
              style: GoogleFonts.poppins(
                fontSize: 14,
                color: const Color(0xFF2F3A32).withOpacity(0.6),
              ),
            ),
            const SizedBox(height: 32),
            if (onRetry != null)
              SizedBox(
                width: 200,
                child: ElevatedButton(
                  onPressed: onRetry,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF1a1a1a),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: const Text('RETRY ACTION'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
