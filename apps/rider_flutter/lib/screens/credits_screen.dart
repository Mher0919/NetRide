// lib/screens/credits_screen.dart
//
// "Ride Credits" — balance + full transaction ledger.

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../components/state_container.dart';
import '../models/reward_models.dart';
import '../services/rewards_service.dart';

class CreditsScreen extends StatefulWidget {
  const CreditsScreen({super.key});

  @override
  State<CreditsScreen> createState() => _CreditsScreenState();
}

class _CreditsScreenState extends State<CreditsScreen> {
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  CreditAccount? _account;
  List<CreditTransaction> _transactions = [];

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
        RewardsService.getCredits(),
        RewardsService.getCreditTransactions(),
      ]);
      if (!mounted) return;
      setState(() {
        _account = results[0] as CreditAccount;
        _transactions = (results[1] as List<CreditTransaction>);
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
        title: Text('Ride Credits', style: theme.textTheme.headlineMedium?.copyWith(fontSize: 24)),
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
    final account = _account!;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF5B7760), Color(0xFF2F3A32)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Available balance',
                  style: TextStyle(color: Colors.white70, fontSize: 13),
                ),
                const SizedBox(height: 6),
                Text(
                  formatCents(account.balanceCents),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 34,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 14),
                Text(
                  'Credits apply automatically to your next ride — you choose at checkout.',
                  style: TextStyle(color: Colors.white.withOpacity(0.8), fontSize: 12),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'Transaction history',
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
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

  Widget _txTile(CreditTransaction t) {
    final isCredit = t.amountCents >= 0;
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
            backgroundColor: (isCredit ? const Color(0xFF6E8B74) : const Color(0xFFC65A5A)).withOpacity(0.12),
            child: Icon(
              isCredit ? Icons.add_rounded : Icons.remove_rounded,
              size: 20,
              color: isCredit ? const Color(0xFF6E8B74) : const Color(0xFFC65A5A),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _title(t),
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Color(0xFF2F3A32)),
                ),
                const SizedBox(height: 2),
                Text(
                  _subtitle(t),
                  style: TextStyle(fontSize: 12, color: const Color(0xFF2F3A32).withOpacity(0.55)),
                ),
              ],
            ),
          ),
          Text(
            formatCents(t.amountCents),
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: isCredit ? const Color(0xFF6E8B74) : const Color(0xFFC65A5A),
            ),
          ),
        ],
      ),
    );
  }

  String _title(CreditTransaction t) {
    switch (t.type) {
      case 'REFERRAL_REWARD':
        return 'Referral reward';
      case 'ADMIN_GRANT':
        return 'Bonus credits';
      case 'RIDE_APPLIED':
        return 'Applied to ride';
      case 'RIDE_REFUND':
        return 'Refunded from cancelled ride';
      default:
        return t.description ?? t.type.replaceAll('_', ' ');
    }
  }

  String _subtitle(CreditTransaction t) {
    final date = DateFormat('MMM d, y · h:mm a').format(t.createdAt);
    if (t.description != null && t.description!.isNotEmpty) return '$date · ${t.description}';
    return date;
  }
}
