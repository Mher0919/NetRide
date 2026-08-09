// lib/screens/wallet_screen.dart
//
// Payment Method screen — the rider's payment instrument, NOT a dollar
// balance. The internal wallet serves as the default payment method;
// its transaction history is preserved for accounting transparency.

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../components/state_container.dart';
import '../models/reward_models.dart';
import '../services/rewards_service.dart';

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  WalletAccount? _account;
  List<WalletTransaction> _transactions = [];

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _state = ViewState.loading;
      _errorMessage = null;
    });
    try {
      final results = await Future.wait([
        RewardsService.getWallet(),
        RewardsService.getWalletTransactions(),
      ]);
      if (!mounted) return;
      setState(() {
        _account = results[0] as WalletAccount;
        _transactions = results[1] as List<WalletTransaction>;
        _state = ViewState.success;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = e.toString();
        _state = ViewState.failure;
      });
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
          'Payment Method',
          style: theme.textTheme.headlineMedium?.copyWith(fontSize: 24),
        ),
      ),
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _fetch,
        successWidget: _account == null ? const SizedBox.shrink() : _buildContent(),
      ),
    );
  }

  Widget _buildContent() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF2F3A32), Color(0xFF46584B)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: Colors.white.withOpacity(0.14),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: const Icon(
                    Icons.credit_card_rounded,
                    color: Color(0xFFE8D9B5),
                    size: 24,
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Default Payment Method',
                        style: TextStyle(color: Colors.white70, fontSize: 13),
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        'Saved payment method',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Your payment method is charged automatically after promos and ride credits are applied.',
                        style: TextStyle(
                          color: Colors.white.withOpacity(0.8),
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'Payment history',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w700,
              color: const Color(0xFF2F3A32),
            ),
          ),
          const SizedBox(height: 12),
          if (_transactions.isEmpty)
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F4EF),
                borderRadius: BorderRadius.circular(20),
              ),
              child: const Text(
                'No transactions yet.',
                style: TextStyle(fontSize: 14, color: Color(0xFF2F3A32)),
              ),
            )
          else
            ..._transactions.map((t) => _txTile(t)),
        ],
      ),
    );
  }

  Widget _txTile(WalletTransaction t) {
    final isDeposit = t.amountCents >= 0;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8D2CA)),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: (isDeposit
                    ? const Color(0xFF5B7760)
                    : const Color(0xFFC65A5A))
                .withOpacity(0.12),
            child: Icon(
              isDeposit
                  ? Icons.add_rounded
                  : Icons.remove_rounded,
              size: 20,
              color: isDeposit
                  ? const Color(0xFF5B7760)
                  : const Color(0xFFC65A5A),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _title(t),
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF2F3A32),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _subtitle(t),
                  style: TextStyle(
                    fontSize: 12,
                    color: const Color(0xFF2F3A32).withOpacity(0.55),
                  ),
                ),
              ],
            ),
          ),
          Text(
            t.amountCents >= 0
                ? formatCents(t.amountCents)
                : '-${formatCents(-t.amountCents)}',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: isDeposit
                  ? const Color(0xFF5B7760)
                  : const Color(0xFFC65A5A),
            ),
          ),
        ],
      ),
    );
  }

  String _title(WalletTransaction t) {
    switch (t.type) {
      case 'ADMIN_GRANT':
        return 'Added to account';
      case 'RIDE_PAYMENT':
        return 'Paid for ride';
      case 'RIDE_REFUND':
        return 'Refunded ride payment';
      default:
        return t.description ?? t.type.replaceAll('_', ' ');
    }
  }

  String _subtitle(WalletTransaction t) {
    final date = DateFormat('MMM d, y · h:mm a').format(t.createdAt);
    if (t.description != null && t.description!.isNotEmpty) {
      return '$date · ${t.description}';
    }
    return date;
  }
}
