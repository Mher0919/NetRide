// lib/screens/wallet_screen.dart
//
// Payment Method screen — the rider's payment instruments. Cards are entered
// INSIDE the app through Stripe's native PaymentSheet (secure entry hosted
// by Stripe; NetRide never sees card numbers). The wallet transaction
// history is preserved for accounting transparency, but there is NO "Add
// funds" flow: adding a card never deposits money or creates a balance.

import 'package:flutter/material.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'package:intl/intl.dart';
import '../components/state_container.dart';
import '../models/reward_models.dart';
import '../services/rewards_service.dart';
import '../services/payments_service.dart';

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
  List<SavedPaymentMethod> _methods = [];
  bool _stripeConfigured = false;
  bool _addingCard = false;

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
        PaymentsService.getProfile(),
      ]);
      if (!mounted) return;
      setState(() {
        _account = results[0] as WalletAccount;
        _transactions = results[1] as List<WalletTransaction>;
        final profile = results[2] as PaymentProfile;
        _stripeConfigured = profile.configured;
        _state = ViewState.success;
      });
      await _loadMethods();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = e.toString();
        _state = ViewState.failure;
      });
    }
  }

  Future<void> _loadMethods() async {
    try {
      final methods = await PaymentsService.listMethods();
      if (!mounted) return;
      setState(() => _methods = methods);
    } catch (_) {
      // Stripe not configured or offline — the payment-method card shows an
      // empty state; nothing financial is ever faked.
      if (mounted) setState(() => _methods = []);
    }
  }

  /// Opens Stripe's native PaymentSheet inside the app. The backend provided
  /// the SetupIntent client secret + ephemeral key; no card data ever passes
  /// through NetRide.
  Future<void> _addCard() async {
    if (_addingCard) return;
    setState(() => _addingCard = true);
    try {
      final session = await PaymentsService.createSetupIntent(consent: true);
      await Stripe.instance.initPaymentSheet(
        paymentSheetParameters: SetupPaymentSheetParameters(
          setupIntentClientSecret: session.setupIntentClientSecret,
          customerId: session.customerId,
          customerEphemeralKeySecret: session.ephemeralKey,
          merchantDisplayName: 'NetRide',
          style: ThemeMode.light,
          appearance: const PaymentSheetAppearance(
            colors: PaymentSheetAppearanceColors(
              primary: Color(0xFF5B7760),
              background: Color(0xFFEEEBE6),
              componentBackground: Color(0xFFFFFFFF),
              componentBorder: Color(0xFFD8D2CA),
              componentText: Color(0xFF2F3A32),
              error: Color(0xFFC65A5A),
            ),
            shapes: PaymentSheetShape(borderRadius: 12),
          ),
          allowsDelayedPaymentMethods: false,
        ),
      );

      await Stripe.instance.presentPaymentSheet();
      // No exception = the sheet completed successfully.
      await PaymentsService.confirmSetupIntent(session.setupIntentId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Payment card saved.')),
      );
      await _loadMethods();
    } on StripeException catch (e) {
      if (!mounted) return;
      final code = e.error.code;
      if (code == FailureCode.Canceled) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Card setup cancelled. No changes were made.')),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not save your card: ${e.error.message ?? 'try again'}')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not open secure card entry: $e')),
      );
    } finally {
      if (mounted) setState(() => _addingCard = false);
    }
  }

  Future<void> _setDefault(SavedPaymentMethod m) async {
    try {
      await PaymentsService.setDefaultMethod(m.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Default payment method updated.')),
      );
      await _loadMethods();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not update the default: $e')),
      );
    }
  }

  Future<void> _removeMethod(SavedPaymentMethod m) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove payment method'),
        content: Text('Remove ${m.label}?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await PaymentsService.removeMethod(m.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Payment method removed.')),
      );
      await _loadMethods();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not remove the card: $e')),
      );
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
          _buildStripeSection(),
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

  // --------------------------------------------------- Stripe cards section

  /// Saved payment methods + in-app card entry. No Add Funds: adding a card
  /// only saves a payment method — it never deposits or charges anything.
  Widget _buildStripeSection() {
    final defaultMethod = _methods.where((m) => m.isDefault).firstOrNull;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F4EF),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.credit_card_rounded,
                  size: 18, color: Color(0xFF5B7760)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  defaultMethod != null
                      ? defaultMethod.label
                      : 'No card on file',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF2F3A32),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          const Text(
            'Your card is used to pay for rides and, only with your consent, '
            'to collect the remaining fare if a sponsor code is not validated '
            'before its deadline.',
            style: TextStyle(fontSize: 12, color: Color(0xFF2F3A32)),
          ),
          const SizedBox(height: 12),
          if (_methods.isNotEmpty) ...[
            ..._methods.map((m) => _methodTile(m)),
            const SizedBox(height: 8),
          ],
          OutlinedButton.icon(
            onPressed: _addingCard ? null : _addCard,
            icon: _addingCard
                ? const SizedBox(
                    width: 16, height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.add_card_rounded, size: 18),
            label: Text(defaultMethod != null ? 'Add another card' : 'Add payment card'),
          ),
          if (!_stripeConfigured)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Secure card entry is not available right now — please try again later.',
                style: TextStyle(fontSize: 11, color: Color(0xFFC65A5A)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _methodTile(SavedPaymentMethod m) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: m.isDefault ? const Color(0xFF5B7760) : const Color(0xFFD8D2CA),
          width: m.isDefault ? 1.5 : 1,
        ),
      ),
      child: Row(
        children: [
          Icon(
            m.isDefault ? Icons.radio_button_checked : Icons.radio_button_off,
            size: 20,
            color: m.isDefault ? const Color(0xFF5B7760) : const Color(0xFF2F3A32).withOpacity(0.35),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              m.label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: m.isDefault ? FontWeight.w700 : FontWeight.w600,
                color: const Color(0xFF2F3A32),
              ),
            ),
          ),
          if (!m.isDefault)
            TextButton(
              onPressed: () => _setDefault(m),
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 32),
              ),
              child: const Text('Make default', style: TextStyle(fontSize: 12)),
            ),
          IconButton(
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.delete_outline, size: 18, color: Color(0xFFC65A5A)),
            onPressed: m.isDefault ? null : () => _removeMethod(m),
            tooltip: m.isDefault ? 'The default card cannot be removed' : 'Remove card',
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