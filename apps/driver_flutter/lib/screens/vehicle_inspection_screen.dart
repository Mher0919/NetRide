import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../providers/driver_provider.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';
import '../utils/file_url.dart';

class VehicleInspectionScreen extends StatefulWidget {
  const VehicleInspectionScreen({super.key});

  @override
  State<VehicleInspectionScreen> createState() =>
      _VehicleInspectionScreenState();
}

class _VehicleInspectionScreenState extends State<VehicleInspectionScreen> {
  final _zipController = TextEditingController();
  final _zipFocusNode = FocusNode();
  bool _isLoading = false;
  bool _hasSearched = false;
  String? _searchError;
  String? _inlineError;
  List<Map<String, dynamic>> _stations = [];

  // Upload + submit state
  List<String> _uploadedUrls = [];
  bool _isUploading = false;
  bool _isSubmitting = false;
  bool _submitSuccess = false;
  static const int _maxImages = 3;

  static const Color _cream = Color(0xFFF7F4EF);
  static const Color _sage = Color(0xFF5B7760);
  static const Color _terracotta = Color(0xFFC65A5A);
  static const Color _darkForest = Color(0xFF2F3A32);

  // California ZIP codes span roughly 90000–96199.
  static bool isCaliforniaZip(String value) {
    final stripped = value.replaceAll(RegExp(r'\s+'), '');
    if (!RegExp(r'^\d{5}$').hasMatch(stripped)) return false;
    final zip = int.tryParse(stripped);
    return zip != null && zip >= 90000 && zip <= 96199;
  }

  @override
  void initState() {
    super.initState();
    _zipController.addListener(_onZipChanged);
  }

  @override
  void dispose() {
    _zipController.removeListener(_onZipChanged);
    _zipController.dispose();
    _zipFocusNode.dispose();
    super.dispose();
  }

  void _onZipChanged() {
    final raw = _zipController.text;
    final stripped = raw.replaceAll(RegExp(r'\s+'), '');
    if (stripped.isEmpty) {
      setState(() => _inlineError = null);
      return;
    }
    if (!RegExp(r'^\d{0,5}$').hasMatch(stripped)) {
      setState(() => _inlineError = 'Numbers only.');
      return;
    }
    if (stripped.length == 5) {
      if (!isCaliforniaZip(stripped)) {
        setState(
          () => _inlineError =
              'NetRide inspections are currently only available in California.\n'
              'Please enter a California ZIP code (90000–96199).',
        );
      } else {
        setState(() => _inlineError = null);
      }
    } else {
      setState(() => _inlineError = null);
    }
  }

  Future<void> _searchLocations() async {
    final zip = _zipController.text.replaceAll(RegExp(r'\s+'), '');
    if (zip.length != 5) {
      setState(() => _searchError = 'Please enter a 5-digit ZIP code.');
      return;
    }
    if (!isCaliforniaZip(zip)) {
      setState(
        () => _searchError =
            'This ZIP code is not a California ZIP code. '
            'NetRide vehicle inspections are currently only available in California (90000–96199).',
      );
      return;
    }

    setState(() {
      _isLoading = true;
      _searchError = null;
      _hasSearched = true;
      _stations = [];
    });

    try {
      final result = await UserService.getInspectionLocations(zip);
      if (!mounted) return;

      final stationsRaw = result['stations'];
      final stations = (stationsRaw is List)
          ? stationsRaw
              .map((s) => Map<String, dynamic>.from(s as Map))
              .toList()
          : <Map<String, dynamic>>[];

      setState(() {
        _stations = stations;
        _isLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      final msg = e.toString();
      if (msg.contains('ZIP_NOT_IN_CALIFORNIA') ||
          msg.contains('404') ||
          msg.contains('outside California')) {
        setState(() {
          _searchError =
              'This ZIP code could not be found or is outside California. '
              'Please enter a valid California ZIP code.';
          _isLoading = false;
        });
      } else {
        setState(() {
          _searchError = 'Could not find inspection locations. '
              'Please check your connection and try again.';
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _openNavigation(double lat, double lon, String name) async {
    final googleUrl =
        'https://www.google.com/maps/dir/?api=1&destination=$lat,$lon&travelmode=driving';
    final googleUri = Uri.parse(googleUrl);
    if (await canLaunchUrl(googleUri)) {
      await launchUrl(googleUri, mode: LaunchMode.externalApplication);
      return;
    }
    // Fallback to geo: URI (opens default map app — Apple Maps on iOS)
    final geoUrl = 'geo:$lat,$lon?q=$lat,$lon(${Uri.encodeComponent(name)})';
    final geoUri = Uri.parse(geoUrl);
    if (await canLaunchUrl(geoUri)) {
      await launchUrl(geoUri, mode: LaunchMode.externalApplication);
      return;
    }
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('No navigation app available on this device.'),
          backgroundColor: _terracotta,
        ),
      );
    }
  }

  /// Upload a single image to Supabase and add the URL to local state.
  /// Does NOT submit for review — that requires an explicit Submit action.
  Future<void> _pickImage() async {
    if (_uploadedUrls.length >= _maxImages) return;

    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 70,
    );
    if (pickedFile == null) return;

    setState(() => _isUploading = true);
    try {
      final url = await AuthService.uploadImage(File(pickedFile.path));
      if (!mounted) return;
      setState(() {
        _uploadedUrls.add(url);
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

  /// Remove an uploaded image from the local list by index.
  /// For now this only removes from local state; orphaned Supabase files
  /// are a known limitation documented in the engineering report.
  void _removeImage(int index) {
    if (index < 0 || index >= _uploadedUrls.length) return;
    setState(() {
      _uploadedUrls.removeAt(index);
    });
  }

  /// Submit all uploaded images for admin review.
  Future<void> _submitForReview() async {
    if (_uploadedUrls.isEmpty || _isSubmitting) return;

    final provider = Provider.of<DriverProvider>(context, listen: false);
    final reqs = provider.documentRequirements;
    final inspectionReq = reqs.cast<Map<String, dynamic>>().firstWhere(
      (r) =>
          r['document_type'] == 'inspection_photo_url' &&
          r['status'] == 'resubmission_required',
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

    setState(() => _isSubmitting = true);
    try {
      await UserService.resubmitDocument(
        inspectionReq['id'],
        newDocumentUrls: List<String>.from(_uploadedUrls),
      );
      if (!mounted) return;
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

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

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
          _bulletPoint(
              'Request a vehicle inspection for ride-share eligibility.'),
          _bulletPoint(
              'Obtain the completed inspection document or certificate.'),
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

  // ---------------------------------------------------------------------------
  // Find locations section
  // ---------------------------------------------------------------------------

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
          'Enter your California ZIP code to find nearby vehicle inspection locations.',
          style: GoogleFonts.inter(
            color: _darkForest.withOpacity(0.6),
            fontSize: 13,
          ),
        ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'State',
                  style: GoogleFonts.inter(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: _darkForest.withOpacity(0.5),
                  ),
                ),
                const SizedBox(height: 4),
                Container(
                  width: 44,
                  height: 48,
                  decoration: BoxDecoration(
                    color: _sage.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: _sage.withOpacity(0.25),
                      width: 1,
                    ),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    'CA',
                    style: GoogleFonts.inter(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: _sage,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(width: 8),
            Expanded(
              child: TextField(
                controller: _zipController,
                focusNode: _zipFocusNode,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
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
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 14,
                  ),
                ),
                style: GoogleFonts.inter(fontSize: 15),
                onSubmitted: _isLoading ? null : (_) => _searchLocations(),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              height: 48,
              child: ElevatedButton(
                onPressed: _isLoading ? null : _searchLocations,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _sage,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                ),
                child: _isLoading
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : Text(
                        'Search',
                        style: GoogleFonts.inter(
                          fontWeight: FontWeight.w700,
                          fontSize: 14,
                        ),
                      ),
              ),
            ),
          ],
        ),
        // Inline validation error (shows as user types)
        if (_inlineError != null) ...[
          const SizedBox(height: 6),
          Text(
            _inlineError!,
            style: GoogleFonts.inter(
              color: _terracotta,
              fontSize: 12,
              height: 1.4,
            ),
          ),
        ],
        // Post-search error
        if (_searchError != null) ...[
          const SizedBox(height: 8),
          Text(
            _searchError!,
            style: GoogleFonts.inter(
              color: _terracotta,
              fontSize: 12,
              height: 1.4,
            ),
          ),
        ],
        // Loading indicator during search
        if (_isLoading) ...[
          const SizedBox(height: 20),
          Center(
            child: Column(
              children: [
                const SizedBox(
                  width: 28,
                  height: 28,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    color: _sage,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  'Searching for nearby inspection stations...',
                  style: GoogleFonts.inter(
                    color: _darkForest.withOpacity(0.6),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
        ],
        // Results
        if (_hasSearched && !_isLoading) ...[
          const SizedBox(height: 16),
          if (_stations.isEmpty) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: _cream,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Column(
                children: [
                  Icon(Icons.search_off_rounded,
                      size: 32, color: _darkForest.withOpacity(0.3)),
                  const SizedBox(height: 8),
                  Text(
                    'No inspection locations found near this ZIP code.',
                    style: GoogleFonts.inter(
                      color: _darkForest.withOpacity(0.7),
                      fontSize: 13,
                      height: 1.4,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Try a different California ZIP code or contact support.',
                    style: GoogleFonts.inter(
                      color: _darkForest.withOpacity(0.5),
                      fontSize: 12,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ] else ...[
            Row(
              children: [
                Icon(Icons.location_on_outlined,
                    size: 14, color: _darkForest.withOpacity(0.5)),
                const SizedBox(width: 4),
                Text(
                  '${_stations.length} nearby ${_stations.length == 1 ? 'location' : 'locations'} found',
                  style: GoogleFonts.inter(
                    color: _darkForest.withOpacity(0.6),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ..._stations.map(
              (loc) => _buildLocationCard(loc),
            ),
          ],
        ],
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // Location card
  // ---------------------------------------------------------------------------

  Widget _buildLocationCard(Map<String, dynamic> loc) {
    final name = (loc['display_name'] as String? ?? '').trim();
    if (name.isEmpty) return const SizedBox.shrink();

    final addressRaw = loc['address'];
    String addressStr = '';
    if (addressRaw is Map) {
      final parts = [
        addressRaw['house_number'],
        addressRaw['road'],
        addressRaw['city'],
        addressRaw['state'],
        addressRaw['postcode'],
      ].where((p) => p != null && p.toString().isNotEmpty);
      addressStr = parts.join(', ');
    }

    final distance = loc['distance_miles'];
    final lat = loc['lat'];
    final lon = loc['lon'];
    final phone = loc['phone'] as String?;
    final hours = loc['opening_hours'] as String?;
    final hasCoords = lat != null && lon != null;

    final double? latNum = hasCoords ? double.tryParse(lat.toString()) : null;
    final double? lonNum = hasCoords ? double.tryParse(lon.toString()) : null;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: _cream,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _sage.withOpacity(0.1)),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () {
            if (latNum != null && lonNum != null) {
              _openNavigation(latNum, lonNum, name);
            }
          },
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: _sage.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(
                    Icons.directions_car_rounded,
                    color: _sage,
                    size: 22,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        style: GoogleFonts.inter(
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          color: _darkForest,
                        ),
                      ),
                      if (addressStr.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          addressStr,
                          style: GoogleFonts.inter(
                            fontSize: 12,
                            color: _darkForest.withOpacity(0.55),
                            height: 1.3,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                      if (distance != null) ...[
                        const SizedBox(height: 4),
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.near_me_outlined,
                                size: 12, color: _sage),
                            const SizedBox(width: 3),
                            Text(
                              '${(distance as num).toStringAsFixed(1)} mi',
                              style: GoogleFonts.inter(
                                fontSize: 12,
                                color: _sage,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ],
                      if (phone != null && phone.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        InkWell(
                          onTap: () async {
                            final telUri = Uri.parse('tel:$phone');
                            if (await canLaunchUrl(telUri)) {
                              await launchUrl(
                                telUri,
                                mode: LaunchMode.externalApplication,
                              );
                            }
                          },
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.call_outlined,
                                  size: 12, color: _sage),
                              const SizedBox(width: 4),
                              Text(
                                phone,
                                style: GoogleFonts.inter(
                                  fontSize: 12,
                                  color: _sage,
                                  fontWeight: FontWeight.w500,
                                  decoration: TextDecoration.underline,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                      if (hours != null && hours.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.access_time_rounded,
                                size: 12, color: _darkForest.withOpacity(0.4)),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                hours,
                                style: GoogleFonts.inter(
                                  fontSize: 11,
                                  color: _darkForest.withOpacity(0.45),
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                if (latNum != null && lonNum != null) ...[
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: () => _openNavigation(latNum, lonNum, name),
                    child: Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: _sage.withOpacity(0.12),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: const Icon(
                        Icons.navigation_rounded,
                        size: 18,
                        color: _sage,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Upload section (multi-image gallery + submit)
  // ---------------------------------------------------------------------------

  Widget _buildUploadSection() {
    // Show success state after submission
    if (_submitSuccess) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: _sage.withOpacity(0.1),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: _sage.withOpacity(0.2)),
        ),
        child: Column(
          children: [
            Icon(Icons.check_circle_rounded, color: _sage, size: 40),
            const SizedBox(height: 12),
            Text(
              'Inspection submitted for review!',
              style: GoogleFonts.inter(
                color: _darkForest,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 4),
            Text(
              '${_uploadedUrls.length} ${_uploadedUrls.length == 1 ? 'image has' : 'images have'} been sent to the admin team for review.',
              style: GoogleFonts.inter(
                color: _darkForest.withOpacity(0.6),
                fontSize: 13,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      );
    }

    final canUpload = _uploadedUrls.length < _maxImages;

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
            'Upload clear photos of your completed vehicle inspection certificate. '
            'Images are saved securely — you must press Submit to send them for review.',
            style: GoogleFonts.inter(
              color: _darkForest.withOpacity(0.6),
              fontSize: 13,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 16),

          // Image gallery
          if (_uploadedUrls.isNotEmpty) ...[
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: List.generate(_uploadedUrls.length, (i) {
                final url = _uploadedUrls[i];
                return _buildImagePreview(url, i);
              }),
            ),
            const SizedBox(height: 16),
          ],

          // Upload button (hidden at max)
          if (canUpload)
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: _isUploading ? null : _pickImage,
                icon: _isUploading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.add_a_photo_outlined, size: 20),
                label: Text(
                  _isUploading
                      ? 'Uploading...'
                      : _uploadedUrls.isEmpty
                          ? 'Select & Upload Image'
                          : 'Add Another Image',
                  style: GoogleFonts.inter(
                    fontWeight: FontWeight.w600,
                    fontSize: 14,
                  ),
                ),
                style: OutlinedButton.styleFrom(
                  foregroundColor: _sage,
                  side: BorderSide(color: _sage.withOpacity(0.4)),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            )
          else ...[
            Container(
              padding: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                color: _sage.withOpacity(0.08),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.check_circle,
                      size: 16, color: _sage.withOpacity(0.6)),
                  const SizedBox(width: 6),
                  Text(
                    'Maximum $_maxImages images uploaded',
                    style: GoogleFonts.inter(
                      color: _sage.withOpacity(0.7),
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ],

          const SizedBox(height: 20),

          // Submit button
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: (_uploadedUrls.isNotEmpty && !_isSubmitting)
                  ? _submitForReview
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
                _isSubmitting ? 'Submitting...' : 'Submit for Review',
                style: GoogleFonts.inter(
                  fontWeight: FontWeight.w700,
                  fontSize: 14,
                ),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: _sage,
                foregroundColor: Colors.white,
                disabledBackgroundColor: _darkForest.withOpacity(0.12),
                disabledForegroundColor: _darkForest.withOpacity(0.35),
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
          ),
          if (_uploadedUrls.isEmpty) ...[
            const SizedBox(height: 6),
            Text(
              'Upload at least one image to enable submission.',
              style: GoogleFonts.inter(
                color: _darkForest.withOpacity(0.4),
                fontSize: 11,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildImagePreview(String url, int index) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        width: (MediaQuery.of(context).size.width - 60) / 3, // 3 per row
        height: (MediaQuery.of(context).size.width - 60) / 3,
        child: Stack(
          children: [
            // Image
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
                    loadingBuilder: (context, child, loadingProgress) {
                      if (loadingProgress == null) return child;
                      return const Center(
                        child: SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      );
                    },
                    errorBuilder: (context, error, stackTrace) {
                      return const Center(
                        child: Icon(Icons.broken_image_outlined,
                            size: 28, color: Colors.grey),
                      );
                    },
                  ),
                ),
              ),
            ),
            // Remove button (X) — top-right corner
            Positioned(
              top: 4,
              right: 4,
              child: GestureDetector(
                onTap: () => _removeImage(index),
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
                    child: CircularProgressIndicator(color: Colors.white),
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
                  child:
                      const Icon(Icons.close_rounded, size: 20, color: Colors.white),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
