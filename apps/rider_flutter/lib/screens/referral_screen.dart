// lib/screens/referral_screen.dart
//
// "Refer & Earn" — shows the rider's referral QR + code, share actions,
// and the history of friends who scanned / completed rides.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../components/state_container.dart';
import '../models/reward_models.dart';
import '../services/rewards_service.dart';
import 'qr_scanner_screen.dart';

class ReferralScreen extends StatefulWidget {
  const ReferralScreen({super.key});

  @override
  State<ReferralScreen> createState() => _ReferralScreenState();
}

class _ReferralScreenState extends State<ReferralScreen> {
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  ReferralInfo? _info;

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
      final info = await RewardsService.getReferralInfo();
      if (!mounted) return;
      setState(() {
        _info = info;
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

  Future<void> _copyToClipboard(String text, String label) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$label copied to clipboard')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text('Refer & Earn', style: theme.textTheme.headlineMedium?.copyWith(fontSize: 24)),
      ),
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _fetch,
        successWidget: _info == null ? const SizedBox.shrink() : _buildContent(theme),
      ),
    );
  }

  Widget _buildContent(ThemeData theme) {
    final info = _info!;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: const Color(0xFFF7F4EF),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: const Color(0xFFD8D2CA)),
            ),
            child: Column(
              children: [
                Text(
                  'Share your code — you both get \$5 in ride credits',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF2F3A32),
                  ),
                ),
                const SizedBox(height: 20),
                if (info.qrPayload.isNotEmpty)
                  QrImageView(
                    data: info.qrPayload,
                    version: QrVersions.auto,
                    size: 190,
                    backgroundColor: Colors.white,
                    padding: const EdgeInsets.all(10),
                    eyeStyle: const QrEyeStyle(
                      eyeShape: QrEyeShape.square,
                      color: Color(0xFF2F3A32),
                    ),
                    dataModuleStyle: const QrDataModuleStyle(
                      dataModuleShape: QrDataModuleShape.square,
                      color: Color(0xFF2F3A32),
                    ),
                  ),
                const SizedBox(height: 16),
                InkWell(
                  onTap: () => _copyToClipboard(info.code, 'Referral code'),
                  borderRadius: BorderRadius.circular(12),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: const Color(0xFF5B7760), width: 1.5),
                    ),
                    child: Text(
                      info.code,
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 4,
                        color: Color(0xFF5B7760),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'or share your link',
                  style: TextStyle(
                    fontSize: 13,
                    color: const Color(0xFF2F3A32).withOpacity(0.6),
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _copyToClipboard(info.referralUrl, 'Referral link'),
                        icon: const Icon(Icons.link_rounded, size: 18),
                        label: const Text('Copy link'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF5B7760),
                          side: const BorderSide(color: Color(0xFF5B7760)),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _copyToClipboard(info.code, 'Referral code'),
                        icon: const Icon(Icons.copy_rounded, size: 18),
                        label: const Text('Copy code'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF5B7760),
                          side: const BorderSide(color: Color(0xFF5B7760)),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: _statCard(theme, 'Friends joined', '${info.referredCount}'),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _statCard(theme, 'Earned so far', formatCents(info.rewardsEarnedCents)),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton.icon(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => const QrScannerScreen()),
              ),
              icon: const Icon(Icons.qr_code_scanner_rounded, size: 20),
              label: const Text('Scan a friend\'s QR'),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF2F3A32),
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
          const SizedBox(height: 28),
          Text(
            'Referral activity',
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
          ),
          const SizedBox(height: 12),
          if (info.history.isEmpty)
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F4EF),
                borderRadius: BorderRadius.circular(20),
              ),
              child: const Text(
                'No referrals yet. Share your QR and earn \$5 when a friend completes their first ride.',
                style: TextStyle(fontSize: 14, color: Color(0xFF2F3A32)),
              ),
            )
          else
            ...info.history.map((h) => _historyTile(h)),
        ],
      ),
    );
  }

  Widget _statCard(ThemeData theme, String label, String value) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFD8D2CA)),
      ),
      child: Column(
        children: [
          Text(
            value,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Color(0xFF5B7760)),
          ),
          const SizedBox(height: 4),
          Text(
            label,
            style: const TextStyle(fontSize: 13, color: Color(0xFF2F3A32)),
          ),
        ],
      ),
    );
  }

  Widget _historyTile(ReferralHistoryEntry h) {
    final status = h.status;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8D2CA)),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 20,
            backgroundColor: const Color(0xFF5B7760).withOpacity(0.12),
            child: const Icon(Icons.person_outline_rounded, color: Color(0xFF5B7760)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  h.friendName ?? 'Friend',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Color(0xFF2F3A32)),
                ),
                const SizedBox(height: 2),
                Text(
                  _subtitle(h),
                  style: TextStyle(fontSize: 12, color: const Color(0xFF2F3A32).withOpacity(0.6)),
                ),
              ],
            ),
          ),
          _statusChip(status),
        ],
      ),
    );
  }

  String _subtitle(ReferralHistoryEntry h) {
    final date = h.scannedAt;
    final dateStr = date != null ? DateFormat('MMM d, y').format(date) : '';
    switch (h.status) {
      case 'LINKED':
        return 'Joined $dateStr — pending first ride';
      case 'FIRST_RIDE_PENDING':
        return 'First ride in progress';
      case 'FIRST_RIDE_COMPLETED':
        return 'First ride completed — reward coming';
      case 'REWARD_GRANTED':
        return 'Rewarded ${formatCents(h.amountCents)}';
      default:
        return dateStr;
    }
  }

  Widget _statusChip(String status) {
    final (label, color) = switch (status) {
      'REWARD_GRANTED' => ('Earned', const Color(0xFF6E8B74)),
      'FIRST_RIDE_COMPLETED' => ('Completed', const Color(0xFF6E8B74)),
      'FIRST_RIDE_PENDING' => ('In progress', const Color(0xFFC79A4A)),
      _ => ('Linked', const Color(0xFF5B7760)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: color),
      ),
    );
  }
}
