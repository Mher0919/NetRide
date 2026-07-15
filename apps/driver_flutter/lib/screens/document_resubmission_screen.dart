import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import '../providers/driver_provider.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';

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

  static const _docLabels = <String, String>{
    'license_photo_url': 'Driver License (Front)',
    'license_photo_back_url': 'Driver License (Back)',
    'insurance_photo_url': 'Insurance Certificate',
    'registration_photo_url': 'Vehicle Registration',
    'inspection_photo_url': 'Vehicle Inspection',
    'id_photo_front_url': 'ID Card (Front)',
    'id_photo_back_url': 'ID Card (Back)',
  };

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() => _isLoading = true);
    try {
      final provider = Provider.of<DriverProvider>(context, listen: false);
      // Use cache-first fetch; background revalidation happens automatically
      await provider.fetchDocumentRequirements();
      setState(() {
        _requirements = provider.documentRequirements
            .where((r) => r['status'] != 'reviewed')
            .toList();
        _isLoading = false;
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

  Future<void> _pickAndUpload(String requirementId, String docType) async {
    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 70,
    );
    if (pickedFile == null) return;

    setState(() => _isUploading = true);
    try {
      final url = await AuthService.uploadImage(File(pickedFile.path));
      await UserService.resubmitDocument(requirementId, url);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Document submitted for review!'),
            backgroundColor: Color(0xFF5B7760),
          ),
        );
      }
      _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Upload failed: $e'),
            backgroundColor: Color(0xFFC65A5A),
          ),
        );
      }
    } finally {
      setState(() => _isUploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text(
          'Document Requirements',
          style: GoogleFonts.inter(
            color: const Color(0xFF2F3A32),
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
                            size: 64, color: const Color(0xFF5B7760)),
                        const SizedBox(height: 16),
                        const Text(
                          'No pending requirements',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF2F3A32),
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
              : ListView.builder(
                  padding: const EdgeInsets.all(20),
                  itemCount: _requirements.length,
                  itemBuilder: (context, index) {
                    final r = _requirements[index];
                    final docType = r['document_type'] as String? ?? '';
                    final label = _docLabels[docType] ?? docType;
                    final status = r['status'] as String? ?? '';
                    final reason = r['request_reason'] as String? ?? '';

                    return Container(
                      margin: const EdgeInsets.only(bottom: 16),
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(
                          color: status == 'resubmission_required'
                              ? const Color(0xFFC65A5A)
                              : const Color(0xFFD8D2CA),
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Icon(
                                status == 'resubmission_required'
                                    ? Icons.error_outline_rounded
                                    : Icons.hourglass_bottom_rounded,
                                color: status == 'resubmission_required'
                                    ? const Color(0xFFC65A5A)
                                    : const Color(0xFFC79A4A),
                                size: 20,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  label,
                                  style: const TextStyle(
                                    fontSize: 16,
                                    fontWeight: FontWeight.w700,
                                    color: Color(0xFF2F3A32),
                                  ),
                                ),
                              ),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 10, vertical: 4),
                                decoration: BoxDecoration(
                                  color: status == 'resubmission_required'
                                      ? const Color(0xFFFCE9E9)
                                      : const Color(0xFFFCF4E0),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Text(
                                  status == 'resubmission_required'
                                      ? 'REQUIRED'
                                      : 'REVIEWING',
                                  style: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w800,
                                    color: status == 'resubmission_required'
                                        ? const Color(0xFFC65A5A)
                                        : const Color(0xFFC79A4A),
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
                                color: const Color(0xFFF7F4EF),
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
                                      color: Color(0xFF2F3A32),
                                      height: 1.35,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                          if (status == 'resubmission_required') ...[
                            const SizedBox(height: 16),
                            SizedBox(
                              width: double.infinity,
                              child: ElevatedButton.icon(
                                onPressed: _isUploading
                                    ? null
                                    : () =>
                                        _pickAndUpload(r['id'], docType),
                                icon: _isUploading
                                    ? const SizedBox(
                                        width: 16,
                                        height: 16,
                                        child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                            color: Colors.white),
                                      )
                                    : const Icon(Icons.cloud_upload_outlined),
                                label: Text(
                                    _isUploading
                                        ? 'Uploading...'
                                        : 'Upload New Document',
                                    style: GoogleFonts.inter(
                                        fontWeight: FontWeight.w700)),
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF5B7760),
                                  foregroundColor: Colors.white,
                                  padding:
                                      const EdgeInsets.symmetric(vertical: 14),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(14),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    );
                  },
                ),
    );
  }
}
