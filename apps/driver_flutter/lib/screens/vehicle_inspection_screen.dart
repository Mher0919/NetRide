import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import '../providers/driver_provider.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';

class VehicleInspectionScreen extends StatefulWidget {
  const VehicleInspectionScreen({super.key});

  @override
  State<VehicleInspectionScreen> createState() => _VehicleInspectionScreenState();
}

class _VehicleInspectionScreenState extends State<VehicleInspectionScreen> {
  final _zipController = TextEditingController();
  bool _isSearching = false;
  bool _isUploading = false;
  bool _hasSearched = false;
  String? _searchError;
  List<Map<String, dynamic>> _locations = [];

  static const Color _cream = Color(0xFFF7F4EF);
  static const Color _sage = Color(0xFF5B7760);
  static const Color _terracotta = Color(0xFFC65A5A);
  static const Color _darkForest = Color(0xFF2F3A32);

  @override
  void dispose() {
    _zipController.dispose();
    super.dispose();
  }

  bool _isValidZip(String value) {
    final stripped = value.replaceAll(RegExp(r'\s+'), '');
    return RegExp(r'^\d{5}$').hasMatch(stripped);
  }

  Future<void> _searchLocations() async {
    final zip = _zipController.text.trim();
    if (!_isValidZip(zip)) {
      setState(() => _searchError = 'Please enter a valid 5-digit ZIP code.');
      return;
    }

    setState(() {
      _isSearching = true;
      _searchError = null;
      _hasSearched = true;
      _locations = [];
    });

    try {
      final results = await UserService.getInspectionLocations(zip);
      if (!mounted) return;
      setState(() {
        _locations = results;
        _isSearching = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searchError = 'Could not find inspection locations. Please try again.';
        _isSearching = false;
      });
    }
  }

  Future<void> _pickAndUpload() async {
    final provider = Provider.of<DriverProvider>(context, listen: false);
    final reqs = provider.documentRequirements;
    final inspectionReq = reqs.cast<Map<String, dynamic>>().firstWhere(
      (r) => r['document_type'] == 'inspection_photo_url' && r['status'] == 'resubmission_required',
      orElse: () => <String, dynamic>{},
    );
    if (inspectionReq.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('No pending inspection requirement found.'),
            backgroundColor: _terracotta,
          ),
        );
      }
      return;
    }

    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 70,
    );
    if (pickedFile == null) return;

    setState(() => _isUploading = true);
    try {
      final url = await AuthService.uploadImage(File(pickedFile.path));
      await UserService.resubmitDocument(inspectionReq['id'], url);
      if (mounted) {
        await provider.refreshProfile();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Inspection document submitted for review!'),
            backgroundColor: _sage,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Upload failed: $e'),
            backgroundColor: _terracotta,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isUploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: _darkForest),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text(
          'Vehicle Inspection',
          style: GoogleFonts.inter(
            color: _darkForest,
            fontSize: 18,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildExplanationSection(),
            const SizedBox(height: 24),
            _buildFindLocationsSection(),
            const SizedBox(height: 24),
            _buildUploadSection(),
          ],
        ),
      ),
    );
  }

  Widget _buildExplanationSection() {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: _cream,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.info_outline, color: _sage, size: 20),
              const SizedBox(width: 8),
              Text(
                'Why this is required',
                style: GoogleFonts.inter(
                  color: _darkForest,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'A vehicle inspection is required to ensure your vehicle meets our safety and quality standards.',
            style: GoogleFonts.inter(
              color: _darkForest.withOpacity(0.8),
              fontSize: 14,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'What you need to do:',
            style: GoogleFonts.inter(
              color: _darkForest,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          _bulletPoint('Visit a certified vehicle inspection location.'),
          _bulletPoint('Request a vehicle inspection for ride-share eligibility.'),
          _bulletPoint('Obtain the completed inspection document or certificate.'),
          _bulletPoint('Upload the document below using a photo or scan.'),
        ],
      ),
    );
  }

  Widget _bulletPoint(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('  \u2022  ', style: TextStyle(fontSize: 14)),
          Expanded(
            child: Text(
              text,
              style: GoogleFonts.inter(
                color: _darkForest.withOpacity(0.8),
                fontSize: 13,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildFindLocationsSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Find inspection locations near you',
          style: GoogleFonts.inter(
            color: _darkForest,
            fontSize: 16,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          'Enter your ZIP code to find nearby vehicle inspection locations.',
          style: GoogleFonts.inter(
            color: _darkForest.withOpacity(0.6),
            fontSize: 13,
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _zipController,
                keyboardType: TextInputType.number,
                maxLength: 5,
                decoration: InputDecoration(
                  counterText: '',
                  hintText: 'ZIP code',
                  filled: true,
                  fillColor: _cream,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                ),
                style: GoogleFonts.inter(fontSize: 15),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              height: 48,
              child: ElevatedButton(
                onPressed: _isSearching ? null : _searchLocations,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _sage,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                ),
                child: _isSearching
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : Text(
                        'Search',
                        style: GoogleFonts.inter(fontWeight: FontWeight.w700, fontSize: 14),
                      ),
              ),
            ),
          ],
        ),
        if (_searchError != null) ...[
          const SizedBox(height: 8),
          Text(
            _searchError!,
            style: GoogleFonts.inter(color: _terracotta, fontSize: 12),
          ),
        ],
        if (_hasSearched && !_isSearching) ...[
          const SizedBox(height: 16),
          if (_locations.isEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: _cream,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Text(
                'No inspection locations found near this ZIP code. Try a different ZIP code or contact support.',
                style: GoogleFonts.inter(
                  color: _darkForest.withOpacity(0.7),
                  fontSize: 13,
                  height: 1.4,
                ),
              ),
            )
          else ...[
            Text(
              'Nearby vehicle inspection locations',
              style: GoogleFonts.inter(
                color: _darkForest.withOpacity(0.7),
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            ..._locations.map((loc) => _buildLocationCard(loc)),
          ],
        ],
      ],
    );
  }

  Widget _buildLocationCard(Map<String, dynamic> loc) {
    final name = (loc['display_name'] as String? ?? '').split(',')[0].trim();
    final address = (loc['display_name'] as String? ?? '').split(',').skip(1).join(',').trim();
    final distance = loc['distance_miles'];
    final lat = loc['lat'];
    final lon = loc['lon'];

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: _cream,
        borderRadius: BorderRadius.circular(16),
      ),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: _sage.withOpacity(0.15),
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Icon(Icons.directions_car_rounded, color: _sage, size: 22),
        ),
        title: Text(
          name,
          style: GoogleFonts.inter(
            fontWeight: FontWeight.w600,
            fontSize: 14,
            color: _darkForest,
          ),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 2),
            Text(
              address,
              style: GoogleFonts.inter(
                fontSize: 12,
                color: _darkForest.withOpacity(0.6),
              ),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            if (distance != null) ...[
              const SizedBox(height: 2),
              Text(
                '${distance.toStringAsFixed(1)} mi',
                style: GoogleFonts.inter(
                  fontSize: 11,
                  color: _sage,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ],
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (lat != null && lon != null)
              IconButton(
                icon: const Icon(Icons.map_outlined, size: 20, color: _sage),
                onPressed: () {
                  // ignore: deprecated_member_use
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('Directions to $name'),
                      backgroundColor: _sage,
                      duration: const Duration(seconds: 3),
                    ),
                  );
                },
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildUploadSection() {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: _cream,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.cloud_upload_outlined, color: _sage, size: 20),
              const SizedBox(width: 8),
              Text(
                'Upload inspection document',
                style: GoogleFonts.inter(
                  color: _darkForest,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Upload a clear photo or scan of your completed vehicle inspection certificate.',
            style: GoogleFonts.inter(
              color: _darkForest.withOpacity(0.6),
              fontSize: 13,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: _isUploading ? null : _pickAndUpload,
              icon: _isUploading
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Icon(Icons.image_outlined, size: 20),
              label: Text(
                _isUploading ? 'Uploading...' : 'Select & Upload',
                style: GoogleFonts.inter(fontWeight: FontWeight.w700, fontSize: 14),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: _sage,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
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
}
