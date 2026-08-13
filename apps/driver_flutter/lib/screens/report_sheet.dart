import 'package:flutter/material.dart';
import 'package:dio/dio.dart';
import 'package:google_fonts/google_fonts.dart';
import '../services/api_service.dart';

class ReasonOption {
  final String code;
  final String label;

  const ReasonOption({required this.code, required this.label});

  factory ReasonOption.fromJson(Map<String, dynamic> json) =>
      ReasonOption(code: json['code'] as String, label: json['label'] as String);
}

/// Bottom sheet that requires a cancellation reason before the driver
/// releases an accepted ride (042). Returns the selected code, or null if
/// dismissed.
class CancellationReasonSheet extends StatefulWidget {
  const CancellationReasonSheet({super.key});

  @override
  State<CancellationReasonSheet> createState() => _CancellationReasonSheetState();
}

class _CancellationReasonSheetState extends State<CancellationReasonSheet> {
  final _otherController = TextEditingController();
  ReasonOption? _selected;
  bool _submitting = false;

  // Static mirror of backend CANCELLATION_REASONS[DRIVER]. The server
  // validates the code, so an outdated client list only reduces choice.
  static const List<ReasonOption> _reasons = [
    ReasonOption(code: 'vehicle_issue', label: 'Vehicle issue'),
    ReasonOption(code: 'too_far_pickup', label: 'Pickup is too far away'),
    ReasonOption(code: 'personal_emergency', label: 'Personal emergency'),
    ReasonOption(code: 'unruly_rider', label: 'Rider was unruly'),
    ReasonOption(code: 'other', label: 'Another reason'),
  ];

  @override
  void dispose() {
    _otherController.dispose();
    super.dispose();
  }

  void _confirm() {
    if (_selected == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please choose a reason before cancelling.')),
      );
      return;
    }
    if (_selected!.code == 'other' && _otherController.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please tell us the reason.')),
      );
      return;
    }
    Navigator.pop(
      context,
      (
        code: _selected!.code,
        label: _selected!.code == 'other'
            ? _otherController.text.trim()
            : _selected!.label,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 24,
        right: 24,
        top: 24,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Why are you cancelling?',
            style: GoogleFonts.poppins(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              color: Colors.black,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Cancelling an accepted ride affects your acceptance record, so let us know why.',
            style: GoogleFonts.poppins(fontSize: 13, color: Colors.grey[600]),
          ),
          const SizedBox(height: 16),
          Flexible(
            child: ListView.separated(
              shrinkWrap: true,
              itemCount: _reasons.length,
              separatorBuilder: (_, __) => const SizedBox(height: 4),
              itemBuilder: (context, index) {
                final option = _reasons[index];
                final isOther = option.code == 'other';
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    InkWell(
                      borderRadius: BorderRadius.circular(12),
                      onTap: () => setState(() => _selected = option),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(12),
                          color: _selected?.code == option.code
                              ? const Color(0xFF5B7760).withOpacity(0.12)
                              : Colors.transparent,
                        ),
                        child: Row(
                          children: [
                            Icon(
                              _selected?.code == option.code
                                  ? Icons.radio_button_checked
                                  : Icons.radio_button_off,
                              size: 20,
                              color: _selected?.code == option.code
                                  ? const Color(0xFF5B7760)
                                  : Colors.grey[400],
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                option.label,
                                style: GoogleFonts.poppins(fontSize: 14, color: Colors.black87),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (isOther && _selected?.code == 'other')
                      Padding(
                        padding: const EdgeInsets.only(left: 32, top: 8),
                        child: TextField(
                          controller: _otherController,
                          maxLength: 300,
                          decoration: const InputDecoration(
                            hintText: 'Tell us more…',
                            isDense: true,
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            height: 50,
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Colors.black,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
              onPressed: _submitting ? null : _confirm,
              child: Text(
                'Cancel Ride',
                style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w700),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Bottom sheet that submits a report against the other ride party (042).
/// Reason list + eligibility come from the backend.
class ReportSheet extends StatefulWidget {
  final String rideId;

  const ReportSheet({super.key, required this.rideId});

  @override
  State<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<ReportSheet> {
  bool _loading = true;
  String? _loadError;
  bool _canReport = false;
  bool _alreadyReported = false;
  String? _reportStatus;
  String? _reportedName;
  List<ReasonOption> _reasons = const [];
  ReasonOption? _selected;
  final _descriptionController = TextEditingController();
  final _otherController = TextEditingController();
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  @override
  void dispose() {
    _descriptionController.dispose();
    _otherController.dispose();
    super.dispose();
  }

  Future<void> _loadStatus() async {
    setState(() => _loading = true);
    try {
      final response = await ApiService.dio.get('/ride/${widget.rideId}/report');
      final data = response.data as Map<String, dynamic>;
      setState(() {
        _canReport = data['canReport'] == true;
        _alreadyReported = data['alreadyReported'] == true;
        _reportStatus = (data['report'] as Map<String, dynamic>?)?['status'] as String?;
        final reported = data['reported_user'] as Map<String, dynamic>?;
        _reportedName = reported?['full_name'] as String?;
        _reasons = ((data['reasons'] as List?) ?? const [])
            .map((e) => ReasonOption.fromJson(e as Map<String, dynamic>))
            .toList();
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _loading = false;
        _loadError = 'Unable to load report details. Please try again.';
      });
    }
  }

  Future<void> _submit() async {
    if (_selected == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please choose a reason.')),
      );
      return;
    }
    final description = _descriptionController.text.trim();
    if (description.length < 10) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please add a few more details (at least 10 characters).')),
      );
      return;
    }
    if (_selected!.code == 'other' && _otherController.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please tell us more about the issue.')),
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      await ApiService.dio.post(
        '/ride/${widget.rideId}/report',
        data: {
          'reason_code': _selected!.code,
          if (_selected!.code == 'other')
            'reason_text': _otherController.text.trim(),
          'description': description,
        },
      );
      if (!mounted) return;
      Navigator.pop(context, true);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Report submitted. Our team will review it.')),
      );
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      final msg = (e.response?.data as Map<String, dynamic>?)?['error'] as String?;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg ?? 'We couldn\'t submit the report. Please try again.')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('We couldn\'t submit the report. Please try again.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 24,
        right: 24,
        top: 24,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Report an issue',
            style: GoogleFonts.poppins(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              color: Colors.black,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            _reportedName != null
                ? 'Tell us what happened on this ride with $_reportedName.'
                : 'Tell us what happened on this ride.',
            style: GoogleFonts.poppins(fontSize: 13, color: Colors.grey[600]),
          ),
          const SizedBox(height: 16),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_loadError != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  Text(_loadError!, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  OutlinedButton(onPressed: _loadStatus, child: const Text('Retry')),
                ],
              ),
            )
          else if (_alreadyReported)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  Icon(Icons.verified_outlined, size: 36, color: const Color(0xFF5B7760)),
                  const SizedBox(height: 12),
                  Text(
                    _reportStatus == 'OPEN'
                        ? 'You already reported this ride. Our team is reviewing it.'
                        : 'A report for this ride is already in review.',
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            )
          else if (!_canReport)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                'Reports can only be filed after the ride has ended, by one of the two parties. Please try again from a completed or cancelled ride.',
                textAlign: TextAlign.center,
              ),
            )
          else ...[
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: _reasons.length,
                separatorBuilder: (_, __) => const SizedBox(height: 4),
                itemBuilder: (context, index) {
                  final option = _reasons[index];
                  final isOther = option.code == 'other';
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: () => setState(() => _selected = option),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(12),
                            color: _selected?.code == option.code
                                ? const Color(0xFF5B7760).withOpacity(0.12)
                                : Colors.transparent,
                          ),
                          child: Row(
                            children: [
                              Icon(
                                _selected?.code == option.code
                                    ? Icons.radio_button_checked
                                    : Icons.radio_button_off,
                                size: 20,
                                color: _selected?.code == option.code
                                    ? const Color(0xFF5B7760)
                                    : Colors.grey[400],
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  option.label,
                                  style: GoogleFonts.poppins(fontSize: 14, color: Colors.black87),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (isOther && _selected?.code == 'other')
                        Padding(
                          padding: const EdgeInsets.only(left: 32, top: 8),
                          child: TextField(
                            controller: _otherController,
                            maxLength: 300,
                            decoration: const InputDecoration(
                              hintText: 'Describe the issue…',
                              isDense: true,
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                    ],
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _descriptionController,
              maxLength: 2000,
              minLines: 2,
              maxLines: 4,
              decoration: const InputDecoration(
                hintText: 'Add a few details so our team can review this (required)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              height: 50,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: Colors.black,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: _submitting ? null : _submit,
                child: Text(
                  _submitting ? 'Submitting…' : 'Submit Report',
                  style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w700),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}