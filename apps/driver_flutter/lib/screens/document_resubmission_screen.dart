import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:provider/provider.dart';
import '../providers/driver_provider.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';
import '../utils/pick_image.dart';
import '../utils/file_url.dart';

class DocumentResubmissionScreen extends StatefulWidget {
  const DocumentResubmissionScreen({super.key});

  @override
  State<DocumentResubmissionScreen> createState() =>
      _DocumentResubmissionScreenState();
}

class _DocumentResubmissionScreenState
    extends State<DocumentResubmissionScreen> {
  List<Map<String, dynamic>> _requirements = [];
  bool _isLoading = true;
  bool _isUploading = false;
  bool _isSubmitting = false;
  bool _submitSuccess = false;

  final Map<String, List<String>> _uploads = {};

  static const _docLabels = <String, String>{
    'license_photo_url': 'Driver License (Front)',
    'license_photo_back_url': 'Driver License (Back)',
    'insurance_photo_url': 'Insurance Certificate',
    'registration_photo_url': 'Vehicle Registration',
    'inspection_photo_url': 'Vehicle Inspection',
    'id_photo_front_url': 'ID Card (Front)',
    'id_photo_back_url': 'ID Card (Back)',
  };

  static const Color _cream = Color(0xFFF7F4EF);
  static const Color _sage = Color(0xFF5B7760);
  static const Color _terracotta = Color(0xFFC65A5A);
  static const Color _darkForest = Color(0xFF2F3A32);

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() => _isLoading = true);
    try {
      final provider = Provider.of<DriverProvider>(context, listen: false);
      await provider.fetchDocumentRequirements();
      final reqs = provider.documentRequirements
          .where((r) =>
              r['status'] == 'resubmission_required' &&
              r['document_type'] != 'inspection_photo_url')
          .toList();
      setState(() {
        _requirements = reqs;
        _isLoading = false;
        _uploads.clear();
        for (final r in reqs) {
          final docType = r['document_type'] as String? ?? '';
          _uploads[docType] = [];
        }
      });
    } catch (e) {
      setState(() => _isLoading = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to load: $e')),
        );
      }
    }
  }

  Future<void> _pickAndUpload(String docType) async {
    final pickedFile = await pickImageWithSource(context, imageQuality: 70);
    if (pickedFile == null) return;

    setState(() => _isUploading = true);
    try {
      final url = await AuthService.uploadImage(File(pickedFile.path));
      if (!mounted) return;
      setState(() {
        _uploads[docType]?.add(url);
        _isUploading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isUploading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Upload failed: $e'),
          backgroundColor: _terracotta,
        ),
      );
    }
  }

  void _removeImage(String docType, int index) {
    final list = _uploads[docType];
    if (list == null || index < 0 || index >= list.length) return;
    setState(() {
      list.removeAt(index);
    });
  }

  bool get _canSubmit {
    if (_requirements.isEmpty) return false;
    for (final r in _requirements) {
      final docType = r['document_type'] as String? ?? '';
      final urls = _uploads[docType];
      if (urls == null || urls.isEmpty) return false;
    }
    return true;
  }

  Future<void> _submitAll() async {
    if (!_canSubmit || _isSubmitting) return;

    setState(() => _isSubmitting = true);
    try {
      final submissions = _requirements.map((r) {
        final docType = r['document_type'] as String? ?? '';
        final urls = List<String>.from(_uploads[docType] ?? []);
        return {
          'requirementId': r['id'],
          'newDocumentUrls': urls,
        };
      }).toList();

      await UserService.batchResubmitDocuments(submissions);

      if (!mounted) return;
      final provider = Provider.of<DriverProvider>(context, listen: false);
      await provider.refreshProfile();
      setState(() {
        _isSubmitting = false;
        _submitSuccess = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _isSubmitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Submission failed: $e'),
          backgroundColor: _terracotta,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_submitSuccess) {
      return Scaffold(
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          elevation: 0,
          title: Text(
            'Document Requirements',
            style: GoogleFonts.inter(
              color: _darkForest,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(40),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.check_circle_rounded,
                    size: 64, color: _sage),
                const SizedBox(height: 16),
                Text(
                  'Documents submitted for review!',
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                    color: _darkForest,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Your documents have been sent to the admin team for review.',
                  style: const TextStyle(color: Color(0xFF6B6B6B)),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text(
          'Document Requirements',
          style: GoogleFonts.inter(
            color: _darkForest,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _requirements.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(40),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.check_circle_outline_rounded,
                            size: 64, color: _sage),
                        const SizedBox(height: 16),
                        const Text(
                          'No pending requirements',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w700,
                            color: _darkForest,
                          ),
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'All your documents are in order.',
                          style: TextStyle(color: Color(0xFF6B6B6B)),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                  children: [
                    ..._requirements.map((r) {
                      final docType =
                          r['document_type'] as String? ?? '';
                      final label =
                          _docLabels[docType] ?? docType;
                      final reason =
                          r['request_reason'] as String? ?? '';
                      final urls = _uploads[docType] ?? [];
                      return _buildRequirementCard(
                        docType: docType,
                        label: label,
                        reason: reason,
                        urls: urls,
                      );
                    }),
                    const SizedBox(height: 24),
                    _buildSubmitButton(),
                  ],
                ),
    );
  }

  Widget _buildRequirementCard({
    required String docType,
    required String label,
    required String reason,
    required List<String> urls,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: urls.isEmpty
              ? _terracotta
              : _sage.withOpacity(0.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                urls.isEmpty
                    ? Icons.error_outline_rounded
                    : Icons.check_circle_outline_rounded,
                color: urls.isEmpty ? _terracotta : _sage,
                size: 20,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: _darkForest,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: urls.isEmpty
                      ? const Color(0xFFFCE9E9)
                      : _sage.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  urls.isEmpty ? 'PENDING' : 'UPLOADED',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    color: urls.isEmpty
                        ? _terracotta
                        : _sage,
                  ),
                ),
              ),
            ],
          ),
          if (reason.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: _cream,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Admin note:',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF6B6B6B),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    reason,
                    style: const TextStyle(
                      fontSize: 13,
                      color: _darkForest,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 16),

          // Uploaded image previews
          if (urls.isNotEmpty) ...[
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: List.generate(urls.length, (i) {
                return _buildImagePreview(
                    urls[i], docType, i);
              }),
            ),
            const SizedBox(height: 12),
          ],

          // Add photo button
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed:
                  _isUploading ? null : () => _pickAndUpload(docType),
              icon: _isUploading
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                          strokeWidth: 2),
                    )
                  : const Icon(Icons.add_a_photo_outlined, size: 20),
              label: Text(
                _isUploading
                    ? 'Uploading...'
                    : urls.isEmpty
                        ? 'Upload New Document'
                        : 'Add Another Photo',
                style: GoogleFonts.inter(
                    fontWeight: FontWeight.w600, fontSize: 14),
              ),
              style: OutlinedButton.styleFrom(
                foregroundColor: _sage,
                side: BorderSide(
                    color: _sage.withOpacity(0.4)),
                padding:
                    const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildImagePreview(
      String url, String docType, int index) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        width: (MediaQuery.of(context).size.width - 100) / 3,
        height: (MediaQuery.of(context).size.width - 100) / 3,
        child: Stack(
          children: [
            GestureDetector(
              onTap: () => _showImagePreview(url),
              child: Container(
                decoration: BoxDecoration(
                  color: _darkForest.withOpacity(0.05),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.network(
                    resolveFileUrl(url),
                    fit: BoxFit.cover,
                    width: double.infinity,
                    height: double.infinity,
                    loadingBuilder:
                        (context, child, loadingProgress) {
                      if (loadingProgress == null) return child;
                      return const Center(
                        child: SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                              strokeWidth: 2),
                        ),
                      );
                    },
                    errorBuilder:
                        (context, error, stackTrace) {
                      return const Center(
                        child: Icon(
                            Icons.broken_image_outlined,
                            size: 28,
                            color: Colors.grey),
                      );
                    },
                  ),
                ),
              ),
            ),
            Positioned(
              top: 4,
              right: 4,
              child: GestureDetector(
                onTap: () => _removeImage(docType, index),
                child: Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(
                    color: Colors.black.withOpacity(0.55),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: const Icon(
                    Icons.close_rounded,
                    size: 16,
                    color: Colors.white,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showImagePreview(String url) {
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.all(16),
        child: Stack(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Image.network(
                resolveFileUrl(url),
                fit: BoxFit.contain,
                width: double.infinity,
                height: double.infinity,
                loadingBuilder: (context, child, loadingProgress) {
                  if (loadingProgress == null) return child;
                  return const Center(
                    child: CircularProgressIndicator(
                        color: Colors.white),
                  );
                },
                errorBuilder: (context, error, stackTrace) {
                  return const Center(
                    child: Icon(Icons.broken_image_outlined,
                        size: 48, color: Colors.white70),
                  );
                },
              ),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: GestureDetector(
                onTap: () => Navigator.pop(ctx),
                child: Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: Colors.black.withOpacity(0.5),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.close_rounded,
                      size: 20, color: Colors.white),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSubmitButton() {
    return Column(
      children: [
        SizedBox(
          width: double.infinity,
          child: ElevatedButton.icon(
            onPressed: (_canSubmit && !_isSubmitting)
                ? _submitAll
                : null,
            icon: _isSubmitting
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.send_rounded, size: 20),
            label: Text(
              _isSubmitting
                  ? 'Submitting...'
                  : 'Submit for Review',
              style: GoogleFonts.inter(
                fontWeight: FontWeight.w700,
                fontSize: 14,
              ),
            ),
            style: ElevatedButton.styleFrom(
              backgroundColor: _sage,
              foregroundColor: Colors.white,
              disabledBackgroundColor:
                  _darkForest.withOpacity(0.12),
              disabledForegroundColor:
                  _darkForest.withOpacity(0.35),
              padding:
                  const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
          ),
        ),
        if (!_canSubmit) ...[
          const SizedBox(height: 6),
          Text(
            'Upload all required documents to enable submission.',
            style: GoogleFonts.inter(
              color: _darkForest.withOpacity(0.4),
              fontSize: 11,
            ),
          ),
        ],
      ],
    );
  }
}
