import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:image_picker/image_picker.dart';
import 'dart:io';
import 'dart:math' as math;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';
import '../components/state_container.dart';
import 'settings_screen.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _nameController = TextEditingController();
  final _phoneController = TextEditingController();
  final _dobController = TextEditingController();
  final _licenseController = TextEditingController();
  final _plateController = TextEditingController();
  final _emailController = TextEditingController();
  
  String _email = '';
  String? _profileImageUrl;
  String? _selectedVehicleId;
  List<dynamic> _vehicles = [];
  Map<String, dynamic>? _activeVehicle;
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  bool _isSaving = false;
  bool _isEditing = false;
  bool _isVerified = false;
  bool _hasPassword = false;
  bool _showVerificationHint = false;
  double _rating = 5.0;
  int _totalRides = 0;

  @override
  void initState() {
    super.initState();
    _fetchProfile();
  }

  Future<void> _fetchProfile() async {
    setState(() => _state = ViewState.loading);
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('jwt_token');
      if (token == null) {
        setState(() => _state = ViewState.success);
        return;
      }

      final profile = await UserService.getProfile();

      List<dynamic> vehicles;
      try {
        vehicles = await UserService.getVehicles();
      } catch (e) {
        debugPrint('Failed to fetch vehicles: $e');
        vehicles = [];
      }

      setState(() {
        _nameController.text = profile['full_name'] ?? '';
        _phoneController.text = profile['phone_number'] ?? '';
        _dobController.text = profile['date_of_birth'] != null 
            ? DateFormat('MM-dd-yyyy').format(DateTime.parse(profile['date_of_birth']))
            : '';
        _licenseController.text = profile['license_number'] ?? '';
        _email = profile['email'] ?? '';
        _emailController.text = _email;
        _profileImageUrl = profile['profile_image_url'];
        _isVerified = profile['is_active'] == true || profile['is_active'] == 'true';
        _hasPassword = profile['has_password'] == true;
        _rating = double.tryParse(profile['rating']?.toString() ?? '') ?? 5.0;
        _totalRides = int.tryParse(profile['rating_count']?.toString() ?? '') ?? 0;
        
        final activeV = profile['active_vehicle'];
        _activeVehicle = activeV is Map<String, dynamic> ? activeV : null;
        if (activeV != null) {
          _selectedVehicleId = activeV['id']?.toString() ?? activeV['vehicle_id']?.toString();
          _plateController.text = activeV['license_plate_number'] ?? '';
        } else if (profile['vehicles'] != null && profile['vehicles'].isNotEmpty) {
          final v = profile['vehicles'][0];
          _selectedVehicleId = v['vehicle_id'];
          _plateController.text = v['license_plate_number'] ?? '';
        }
        
        _vehicles = vehicles;
        _state = ViewState.success;
      });

      // Snapshot originals for the diff in _saveProfile. Capture the
      // fields the admin queue cares about so we can detect real changes.
      _originals = {
        'full_name': profile['full_name'],
        'phone_number': profile['phone_number'],
        'date_of_birth': profile['date_of_birth'],
        'license_number': profile['license_number'],
        'profile_image_url': profile['profile_image_url'],
        'license_plate_number': _activeVehicle?['license_plate_number']
            ?? ((profile['vehicles'] is List && (profile['vehicles'] as List).isNotEmpty)
                ? (profile['vehicles'][0])['license_plate_number']
                : null),
      };
      _hasPendingChange = profile['has_pending_profile_change'] == true;

      try {
        final docReqs = await UserService.getDocumentRequirements();
        final reqs = (docReqs['requirements'] as List?) ?? [];
        _hasDocumentActionRequired =
            reqs.any((r) => (r as Map)['status'] == 'resubmission_required');
      } catch (e) {
        debugPrint('[PROFILE] ❌ Doc req fetch error: $e');
      }
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 404) {
        debugPrint('User not found (404), logging out...');
        await AuthService.logout();
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        }
        return;
      }

      debugPrint('[PROFILE] ❌ _fetchProfile error: $e');
      if (e is FormatException) {
        debugPrint('[PROFILE]   ⚠️ FormatException details: ${e.message}');
      }

      setState(() {
        _state = ViewState.failure;
        _errorMessage = 'We were unable to load your driver credentials. Please verify your connection.';
      });
    }
  }

  Future<void> _handleSupport() async {
    final String body = Uri.encodeComponent('Hello NetRide Support, I am a driver and I need help with...');
    final Uri smsLaunchUri = Uri.parse('sms:7477245408?body=$body');
    try {
      if (!await launchUrl(smsLaunchUri)) {
        throw 'Could not launch SMS';
      }
    } catch (e) {
      if (mounted) {
        showDialog(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Contact Support'),
            content: const Text('Please send an SMS to:\n\n747-724-5408\n\nSample text:\n"Hello NetRide Support, I need help with..."'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      }
    }
  }

  bool _uploadInProgress = false;

  Future<void> _changeProfilePicture() async {
    if (_uploadInProgress) return;
    _uploadInProgress = true;
    setState(() => _isSaving = true);
    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(source: ImageSource.gallery);
    if (pickedFile == null) {
      _uploadInProgress = false;
      setState(() => _isSaving = false);
      return;
    }

    try {
      final url = await AuthService.uploadImage(File(pickedFile.path));
      _uploadInProgress = false;
      setState(() => _isSaving = false);

      if (!mounted) return;
      final reason = await _showChangeReasonDialog('profile picture');
      if (reason == null) return; // user cancelled

      setState(() => _isSaving = true);
      await UserService.submitProfileChange({
        'profile_image_url': url,
        '_reason': reason,
      });
      setState(() {
        _isSaving = false;
        _hasPendingChange = true;
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Profile picture submitted for admin review.'),
            backgroundColor: Color(0xFF5B7760),
          ),
        );
      }
    } on Exception catch (e) {
      _uploadInProgress = false;
      setState(() => _isSaving = false);
      final message = _friendlyUploadError(e);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
      }
    }
  }

  /// Maps common upload errors to user-friendly messages.
  String _friendlyUploadError(dynamic e) {
    if (e is DioException) {
      final data = e.response?.data;
      if (data is Map<String, dynamic>) {
        final err = data['error']?.toString() ?? '';
        if (err.contains('RATE_LIMITED')) {
          return 'You\'ve already submitted a profile change recently. Please wait 24 hours.';
        }
        if (err.contains('PROFILE_CHANGE_PENDING')) {
          return 'You already have a change awaiting review.';
        }
      }
      final code = e.response?.statusCode;
      if (code == 429) return 'Too many requests — please wait and try again.';
      if (code == 413) return 'Image is too large — please choose a smaller one.';
    }
    final s = e.toString().toLowerCase();
    if (s.contains('429') || s.contains('too many') || s.contains('rate limit')) {
      return 'Too many requests — please wait and try again.';
    }
    if (s.contains('413') || s.contains('too large')) {
      return 'Image is too large — please choose a smaller one.';
    }
    if (s.contains('network') || s.contains('timeout') || s.contains('socket')) {
      return 'Network error — please check your connection and try again.';
    }
    return 'Failed to upload image. Please try again.';
  }

  Future<void> _updateAgeAndLicense() async {
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: DateTime.now().subtract(const Duration(days: 365 * 21)),
      firstDate: DateTime(1900),
      lastDate: DateTime.now(),
      builder: (context, child) {
        return Theme(
          data: Theme.of(context).copyWith(
            colorScheme: const ColorScheme.light(
              primary: Colors.black,
              onPrimary: Colors.white,
              surface: Colors.white,
              onSurface: Colors.black,
            ),
          ),
          child: child!,
        );
      },
    );

    if (picked == null) return;
    String newDob = DateFormat('yyyy-MM-dd').format(picked);

    if (!mounted) return;
    
    final proceedFront = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: Text('License Verification (Step 1/2)', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.badge_outlined, size: 80, color: Colors.blue),
            const SizedBox(height: 16),
            Text('Please select a clear picture of the FRONT of your Driver\'s License.', textAlign: TextAlign.center, style: GoogleFonts.poppins()),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
            child: const Text('Select Front Photo'),
          ),
        ],
      ),
    );

    if (proceedFront != true) return;
    final picker = ImagePicker();
    final frontImage = await picker.pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (frontImage == null) return;

    if (!mounted) return;

    final proceedBack = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: Text('License Verification (Step 2/2)', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TweenAnimationBuilder(
              tween: Tween<double>(begin: 0, end: math.pi),
              duration: const Duration(milliseconds: 800),
              builder: (context, double value, child) {
                final isBack = value >= math.pi / 2;
                return Transform(
                  transform: Matrix4.identity()
                    ..setEntry(3, 2, 0.001) // perspective
                    ..rotateY(value),
                  alignment: Alignment.center,
                  child: isBack
                      ? Transform(
                          alignment: Alignment.center,
                          transform: Matrix4.identity()..rotateY(math.pi),
                          child: const Icon(Icons.contact_page_outlined, size: 80, color: Colors.blue),
                        )
                      : const Icon(Icons.badge_outlined, size: 80, color: Colors.blue),
                );
              },
            ),
            const SizedBox(height: 16),
            Text('Now, please select a clear picture of the BACK of your Driver\'s License.', textAlign: TextAlign.center, style: GoogleFonts.poppins()),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
            child: const Text('Select Back Photo'),
          ),
        ],
      ),
    );

    if (proceedBack != true) return;
    final backImage = await picker.pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (backImage == null) return;

    if (!mounted) return;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Submit for Verification?', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_upload_outlined, size: 80, color: Colors.green),
            const SizedBox(height: 16),
            Text('Are you sure you want to submit these photos for license and age verification?', textAlign: TextAlign.center, style: GoogleFonts.poppins()),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            style: ElevatedButton.styleFrom(backgroundColor: Colors.blue, foregroundColor: Colors.white),
            child: const Text('Submit Now'),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    setState(() => _isSaving = true);
    try {
      final frontUrl = await AuthService.uploadImage(File(frontImage.path));
      final backUrl = await AuthService.uploadImage(File(backImage.path));

      await ApiService.dio.post('/driver/verify-identity', data: {
        'license_photo_url': frontUrl,
        'license_photo_back_url': backUrl,
        'date_of_birth': newDob,
        'license_number': _licenseController.text.trim(),
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Verification request sent to admin!')));
        _fetchProfile(); 
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Request failed: $e')));
    } finally {
      setState(() => _isSaving = false);
    }
  }

  Future<void> _showEmailChangeDialog() async {
    final emailController = TextEditingController(text: _email);
    await showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Change Email', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('A verification link will be sent to your new email address.', style: GoogleFonts.poppins(fontSize: 14)),
            const SizedBox(height: 16),
            TextField(
              controller: emailController,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'New Email Address', border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () async {
              final newEmail = emailController.text.trim();
              if (newEmail == _email) return;
              try {
                await AuthService.requestEmailChange(newEmail);
                if (mounted) {
                  Navigator.pop(context);
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Verification link sent to your new email')));
                }
              } catch (e) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
              }
            },
            style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
            child: const Text('Send Link'),
          ),
        ],
      ),
    );
  }

  /// Submits a diff of the currently-edited fields to the admin approval
  /// queue. Every sensitive edit (name, photo, DOB, phone, license, vehicle,
  /// plate, photos, payout card) requires admin approval before going live.
  Future<void> _saveProfile() async {
    final fullName = _nameController.text.trim();
    final phoneNumber = _phoneController.text.trim();
    final dob = _dobController.text.trim();
    final plateNumber = _plateController.text.trim();

    if (fullName.length < 2) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Name must be at least 2 characters')),
      );
      return;
    }

    setState(() => _isSaving = true);
    try {
      // Build the diff against the loaded profile. Only include fields the
      // driver actually changed so the admin queue stays focused.
      final Map<String, dynamic> original = await _loadOriginals();
      final Map<String, dynamic> changes = {};

      void pushIfChanged(String key, dynamic current, dynamic originalValue) {
        final cur = current is String ? current.trim() : current;
        if (cur == null || (cur is String && cur.isEmpty)) return;
        if (cur != originalValue) changes[key] = cur;
      }

      pushIfChanged('full_name', fullName, original['full_name']);
      pushIfChanged('phone_number', phoneNumber, original['phone_number']);
      pushIfChanged(
        'date_of_birth',
        _parseDob(dob),
        original['date_of_birth'],
      );
      // license_number is deliberately excluded — it is not shown on
      // the profile page and should never be re-submitted as a change.
      pushIfChanged(
        'profile_image_url',
        _profileImageUrl,
        original['profile_image_url'],
      );
      pushIfChanged(
        'license_plate_number',
        plateNumber,
        original['license_plate_number'],
      );

      // Payout card is handled separately via the Wallet section — do
      // not bundle it here.

      if (changes.isEmpty) {
        setState(() {
          _isEditing = false;
        });
        if (mounted) _fetchProfile();
        return;
      }

      // If the change touches name or photo, ask for a reason.
      final touchesNameOrPhoto =
          changes.containsKey('full_name') || changes.containsKey('profile_image_url');
      if (touchesNameOrPhoto && mounted) {
        final reason = await _showChangeReasonDialog(
          changes.containsKey('full_name') ? 'name' : 'profile picture',
        );
        if (reason == null) {
          setState(() {
            _isSaving = false;
            _isEditing = false;
          });
          return; // user cancelled
        }
        changes['_reason'] = reason;
      }

      await UserService.submitProfileChange(changes);

      setState(() {
        _isSaving = false;
        _isEditing = false;
        _hasPendingChange = true;
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Submitted for review — you\'ll be notified once an admin approves.',
            ),
            backgroundColor: Color(0xFF5B7760),
            duration: Duration(seconds: 4),
          ),
        );
        _fetchProfile();
      }
    } catch (e) {
      setState(() => _isSaving = false);
      final msg = _friendlyError(e);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(msg),
            backgroundColor: const Color(0xFFC65A5A),
          ),
        );
      }
    }
  }

  bool _hasDocumentActionRequired = false;

  /// Cache of the last-fetched profile values used to compute the diff
  /// in `_saveProfile`. Loaded once per `_fetchProfile` call.
  Map<String, dynamic> _originals = const {};
  bool _hasPendingChange = false;

  Future<Map<String, dynamic>> _loadOriginals() async {
    return _originals;
  }

  String? _parseDob(String text) {
    if (text.isEmpty) return null;
    try {
      return DateFormat('yyyy-MM-dd').format(DateFormat('MM-dd-yyyy').parse(text));
    } catch (_) {
      return text;
    }
  }

  /// Shows a dialog asking the driver why they want to make a change.
  /// Returns the entered reason, or null if cancelled.
  Future<String?> _showChangeReasonDialog(String what) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Text('Why are you changing your $what?',
            style: GoogleFonts.poppins(fontWeight: FontWeight.w700, fontSize: 16)),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 3,
          maxLength: 500,
          decoration: const InputDecoration(
            hintText: 'Tell the admin why you need this change…',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              final text = controller.text.trim();
              if (text.isEmpty) return;
              Navigator.pop(ctx, text);
            },
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF5B7760),
              foregroundColor: Colors.white,
            ),
            child: const Text('Submit'),
          ),
        ],
      ),
    );
    return result;
  }

  String _friendlyError(dynamic e) {
    if (e is DioException) {
      final data = e.response?.data;
      if (data is Map<String, dynamic>) {
        final err = data['error']?.toString() ?? '';
        if (err.contains('PROFILE_CHANGE_PENDING')) {
          return 'You already have a change awaiting review. Wait for it to be approved before submitting a new one.';
        }
        if (err.contains('RATE_LIMITED')) {
          return 'You can only submit one change request every 24 hours. Try again later.';
        }
        if (err.contains('PHONE_NOT_VERIFIED')) {
          return 'Verify the new phone number via OTP before submitting this change.';
        }
        if (err.contains('INVALID_CARD')) {
          return 'That card number isn\'t valid. Check the digits and try again.';
        }
      }
      if (e.response?.statusCode == 429) {
        return 'Too many requests. Please wait and try again later.';
      }
    }
    final raw = e.toString();
    if (raw.contains('PROFILE_CHANGE_PENDING')) {
      return 'You already have a change awaiting review. Wait for it to be approved before submitting a new one.';
    }
    if (raw.contains('RATE_LIMITED')) {
      return 'You can only submit one change request every 24 hours. Try again later.';
    }
    if (raw.contains('PHONE_NOT_VERIFIED')) {
      return 'Verify the new phone number via OTP before submitting this change.';
    }
    if (raw.contains('INVALID_CARD')) {
      return 'That card number isn\'t valid. Check the digits and try again.';
    }
    return 'Could not submit your changes: $raw';
  }

  Future<void> _handleLogout() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Logout', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
        content: const Text('Are you sure you want to log out?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Logout', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );

    if (confirm == true) {
      await AuthService.logout();
      if (mounted) {
        Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        automaticallyImplyLeading: false,
        title: Text(
          'Account',
          style: theme.textTheme.headlineMedium?.copyWith(fontSize: 24),
        ),
        actions: [
          if (_state == ViewState.success)
            ...[
              if (_isEditing)
                Padding(
                  padding: const EdgeInsets.only(right: 4.0),
                  child: IconButton(
                    icon: const Icon(Icons.close_rounded, color: Color(0xFFC65A5A)),
                    onPressed: () {
                      setState(() => _isEditing = false);
                      _fetchProfile();
                    },
                  ),
                ),
              Padding(
                padding: const EdgeInsets.only(right: 12.0),
                child: IconButton(
                  icon: Icon(_isEditing ? Icons.check_circle : Icons.edit_outlined, color: const Color(0xFF5B7760)),
                  onPressed: () {
                    if (_isEditing) {
                      _saveProfile();
                    } else {
                      setState(() => _isEditing = true);
                    }
                  },
                ),
              ),
            ],
        ],
      ),
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _fetchProfile,
        successWidget: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_hasPendingChange) _buildPendingChangeBanner(),
              // Document-action banner removed — handled by availability_screen
              _buildProfileHeader(theme),
              const SizedBox(height: 32),
              _buildSectionCard(
                title: 'Personal Details',
                children: [
                  _buildProfileItem(
                    icon: Icons.person_outline_rounded,
                    label: 'Full Name',
                    controller: _nameController,
                    enabled: _isEditing,
                  ),
                  const Divider(height: 32),
                  _buildProfileItem(
                    icon: Icons.email_outlined,
                    label: 'Email Address',
                    controller: _emailController,
                    enabled: false,
                    onAction: _isEditing ? _showEmailChangeDialog : null,
                  ),
                  const Divider(height: 32),
                  _buildProfileItem(
                    icon: Icons.phone_outlined,
                    label: 'Phone Number',
                    controller: _phoneController,
                    enabled: _isEditing,
                    keyboardType: TextInputType.phone,
                  ),
                  const Divider(height: 32),
                  _buildProfileItem(
                    icon: Icons.cake_outlined,
                    label: 'Date of Birth',
                    controller: _dobController,
                    enabled: false,
                    onAction: _isEditing ? _updateAgeAndLicense : null,
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _buildSectionCard(
                title: 'Vehicle',
                children: [
                  if (_activeVehicle != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Row(
                        children: [
                          Container(
                            width: 48, height: 48,
                            decoration: BoxDecoration(
                              color: const Color(0xFFF7F4EF),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: const Icon(Icons.directions_car_rounded, color: Color(0xFF5B7760), size: 26),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${_activeVehicle!['year']} ${_activeVehicle!['make']} ${_activeVehicle!['model']}',
                                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  '${_activeVehicle!['color']}${_activeVehicle!['interior_color'] != null ? ' / ${_activeVehicle!['interior_color']} Int' : ''}',
                                  style: TextStyle(fontSize: 12, color: const Color(0xFF2F3A32).withOpacity(0.4)),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  const Divider(height: 16),
                  _buildProfileItem(
                    icon: Icons.vpn_key_outlined,
                    label: 'License Plate',
                    controller: _plateController,
                    enabled: _isEditing,
                  ),
                  const Divider(height: 16),
                  _buildMenuTile(
                    icon: Icons.swap_horiz_rounded,
                    title: 'Replace Vehicle',
                    onTap: () => Navigator.pushNamed(context, '/replace-vehicle'),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _buildSectionCard(
                title: 'Settings',
                children: [
                  _buildMenuTile(
                    icon: Icons.settings_outlined,
                    title: 'App Settings',
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(builder: (context) => SettingsScreen(hasPassword: _hasPassword)),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _buildSectionCard(
                title: 'Support',
                children: [
                  _buildMenuTile(
                    icon: Icons.support_agent_rounded,
                    title: 'Customer Support',
                    onTap: _handleSupport,
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _buildWalletCard(),
              const SizedBox(height: 24),
              _buildSectionCard(
                title: 'Account',
                children: [
                  _buildMenuTile(
                    icon: Icons.logout_rounded,
                    title: 'Sign Out',
                    onTap: _handleLogout,
                    textColor: const Color(0xFFC65A5A),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildProfileHeader(ThemeData theme) {
    return Center(
      child: Column(
        children: [
          Stack(
            children: [
              Container(
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0xFFD8D2CA), width: 1),
                ),
                child: _profileImageUrl != null
                    ? ClipOval(
                        child: Image.network(
                          _profileImageUrl!,
                          width: 100,
                          height: 100,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => const Icon(Icons.person, size: 48, color: Color(0xFF5B7760)),
                        ),
                      )
                    : const CircleAvatar(
                        radius: 50,
                        backgroundColor: Color(0xFFF7F4EF),
                        child: Icon(Icons.person, size: 48, color: Color(0xFF5B7760)),
                      ),
              ),
              if (_isEditing)
                Positioned(
                  bottom: 0,
                  right: 0,
                  child: GestureDetector(
                    onTap: _changeProfilePicture,
                    child: Container(
                      padding: const EdgeInsets.all(8),
                      decoration: const BoxDecoration(
                        color: Color(0xFF5B7760),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.camera_alt, size: 16, color: Colors.white),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.star_rounded, color: Color(0xFFC79A4A), size: 20),
              const SizedBox(width: 4),
              Text(
                _rating.toStringAsFixed(1),
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
              ),
              const SizedBox(width: 4),
              Text(
                '($_totalRides rides)',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: const Color(0xFF2F3A32).withOpacity(0.4)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          GestureDetector(
            onTap: () {
              if (!_isVerified) {
                setState(() => _showVerificationHint = true);
                Future.delayed(const Duration(seconds: 3), () {
                  if (mounted) setState(() => _showVerificationHint = false);
                });
              }
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: _isVerified ? const Color(0xFF6E8B74).withOpacity(0.1) : const Color(0xFFC65A5A).withOpacity(0.1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    _isVerified ? Icons.verified_user : Icons.error_outline_rounded,
                    size: 14,
                    color: _isVerified ? const Color(0xFF5B7760) : const Color(0xFFC65A5A),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    _isVerified ? 'VERIFIED DRIVER' : 'PENDING VERIFICATION',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.5,
                      color: _isVerified ? const Color(0xFF5B7760) : const Color(0xFFC65A5A),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_showVerificationHint)
            Padding(
              padding: const EdgeInsets.only(top: 8.0),
              child: Text(
                'Age should be verified to become verified.',
                style: TextStyle(fontSize: 10, color: const Color(0xFFC65A5A), fontWeight: FontWeight.w500),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildSectionCard({required String title, required List<Widget> children}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 12),
          child: Text(
            title,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: Color(0xFF2F3A32),
              letterSpacing: 0.5,
            ),
          ),
        ),
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: const Color(0xFFD8D2CA)),
          ),
          child: Column(
            children: children,
          ),
        ),
      ],
    );
  }

  Widget _buildProfileItem({
    required IconData icon,
    required String label,
    required TextEditingController controller,
    required bool enabled,
    VoidCallback? onAction,
    TextInputType? keyboardType,
  }) {
    return Row(
      children: [
        Icon(icon, size: 20, color: const Color(0xFF2F3A32).withOpacity(0.4)),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  color: const Color(0xFF2F3A32).withOpacity(0.4),
                  fontWeight: FontWeight.w500,
                ),
              ),
              const SizedBox(height: 2),
              enabled
                  ? TextField(
                      controller: controller,
                      keyboardType: keyboardType,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFF2F3A32)),
                      decoration: const InputDecoration(
                        isDense: true,
                        contentPadding: EdgeInsets.zero,
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        filled: false,
                      ),
                    )
                  : Text(
                      controller.text.isEmpty ? 'Not set' : controller.text,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFF2F3A32)),
                    ),
            ],
          ),
        ),
        if (onAction != null)
          GestureDetector(
            onTap: onAction,
            child: const Icon(Icons.edit_outlined, size: 16, color: Color(0xFF5B7760)),
          ),
      ],
    );
  }

  Widget _buildMenuTile({
    required IconData icon,
    required String title,
    required VoidCallback onTap,
    Widget? trailing,
    bool enabled = true,
    Color? textColor,
  }) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      behavior: HitTestBehavior.opaque,
      child: Opacity(
        opacity: enabled ? 1.0 : 0.4,
        child: Row(
          children: [
            Icon(icon, size: 20, color: (textColor ?? const Color(0xFF2F3A32)).withOpacity(0.4)),
            const SizedBox(width: 16),
            Expanded(
              child: Text(
                title,
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: textColor ?? const Color(0xFF2F3A32)),
              ),
            ),
            if (trailing != null) trailing,
            const SizedBox(width: 8),
            Icon(Icons.chevron_right_rounded, size: 20, color: (textColor ?? const Color(0xFF2F3A32)).withOpacity(0.2)),
          ],
        ),
      ),
    );
  }

  // ==========================================================================
  // Pending-change banner + Wallet section
  // ==========================================================================

  Widget _buildPendingChangeBanner() {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFCE9E9),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFEFCFCF)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.pending_actions_rounded, color: Color(0xFFC65A5A), size: 22),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: const [
                Text(
                  'Profile change under review',
                  style: TextStyle(
                    color: Color(0xFF7A2A2A),
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                SizedBox(height: 2),
                Text(
                  'An admin is reviewing your recent edit. You can keep editing — new submissions queue after the current one is reviewed.',
                  style: TextStyle(color: Color(0xFF7A2A2A), fontSize: 12, height: 1.35),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Wallet summary card: balance, lifetime earnings, current payout card,
  /// recent payouts. Matches the existing theme (sage primary, terracotta
  /// accents).
  Widget _buildWalletCard() {
    return FutureBuilder<Map<String, dynamic>>(
      future: UserService.getWallet(),
      builder: (context, snap) {
        if (!snap.hasData) {
          return _buildSectionCard(
            title: 'Wallet',
            children: const [
              Padding(
                padding: EdgeInsets.symmetric(vertical: 18),
                child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
              ),
            ],
          );
        }
        final w = snap.data ?? const {};
        final balanceCents = (w['balance_cents'] as num?)?.toInt() ?? 0;
        final lifetimeCents = (w['lifetime_earnings_cents'] as num?)?.toInt() ?? 0;
        final balance = NumberFormat.simpleCurrency(name: 'USD').format(balanceCents / 100);
        final lifetime = NumberFormat.simpleCurrency(name: 'USD').format(lifetimeCents / 100);
        final card = w['payout_card'] as Map<String, dynamic>?;
        final cardLast4 = card?['last4']?.toString();
        final cardBrand = card?['brand']?.toString().toUpperCase() ?? '';
        final payouts = (w['recent_payouts'] as List?) ?? const [];
        return _buildSectionCard(
          title: 'Wallet',
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Available balance',
                          style: TextStyle(fontSize: 12, color: Color(0xFF6B6B6B), fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Text(balance,
                          style: const TextStyle(
                              fontSize: 28, fontWeight: FontWeight.w800, color: Color(0xFF2F3A32))),
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Text('Lifetime',
                        style: TextStyle(fontSize: 12, color: Color(0xFF6B6B6B), fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(lifetime,
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32))),
                  ],
                ),
              ],
            ),
            const Divider(height: 32),
            _buildProfileRow(
              icon: Icons.credit_card_rounded,
              title: cardLast4 != null && cardLast4.isNotEmpty
                  ? 'Payout card · $cardBrand •••• $cardLast4'
                  : 'No payout card',
              trailing: cardLast4 != null
                  ? TextButton(
                      onPressed: _showPayoutCardDialog,
                      child: const Text('Replace', style: TextStyle(fontWeight: FontWeight.w700)),
                    )
                  : TextButton(
                      onPressed: _showPayoutCardDialog,
                      child: const Text('Add card', style: TextStyle(fontWeight: FontWeight.w700)),
                    ),
            ),
            const Divider(height: 32),
            _buildProfileRow(
              icon: Icons.account_balance_wallet_rounded,
              title: 'Request payout',
              trailing: TextButton(
                onPressed: balanceCents > 0 ? _showRequestPayoutDialog : null,
                child: const Text('Withdraw', style: TextStyle(fontWeight: FontWeight.w700)),
              ),
            ),
            if (payouts.isNotEmpty) ...[
              const Divider(height: 32),
              const Text('Recent payouts',
                  style: TextStyle(fontSize: 12, color: Color(0xFF6B6B6B), fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              ...payouts.map((p) {
                final cents = ((p as Map)['net_cents'] as num?)?.toInt() ?? 0;
                final status = (p['status'] ?? '').toString();
                final requestedAt = p['requested_at']?.toString();
                final method = (p['method'] ?? '').toString();
                String when = '';
                if (requestedAt != null) {
                  try {
                    final dt = DateTime.parse(requestedAt).toLocal();
                    when = DateFormat('MMM d').format(dt);
                  } catch (_) {}
                }
                final amt = NumberFormat.simpleCurrency(name: 'USD').format(cents / 100);
                final isAuto = method == 'WEEKLY_AUTO';
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    children: [
                      Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          color: status == 'PAID' ? const Color(0xFFE5F0EB) : const Color(0xFFFCE9E9),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Icon(
                          isAuto ? Icons.event_repeat_rounded : Icons.payments_rounded,
                          size: 16,
                          color: status == 'PAID' ? const Color(0xFF5B7760) : const Color(0xFFC65A5A),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(isAuto ? 'Weekly auto-payout' : 'On-demand payout',
                                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                            Text(when, style: const TextStyle(fontSize: 11, color: Color(0xFF6B6B6B))),
                          ],
                        ),
                      ),
                      Text(amt,
                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: status == 'PAID' ? const Color(0xFFE5F0EB) : const Color(0xFFFCE9E9),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          status,
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w800,
                            color: status == 'PAID' ? const Color(0xFF5B7760) : const Color(0xFFC65A5A),
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              }),
            ],
          ],
        );
      },
    );
  }

  // ----- Payout card dialog (Luhn-checked, then discarded on server) ------

  Future<void> _showPayoutCardDialog() async {
    final cardNum = TextEditingController();
    final expM = TextEditingController();
    final expY = TextEditingController();
    final name = TextEditingController(text: _nameController.text);
    final zip = TextEditingController();
    final cvc = TextEditingController();
    final formKey = GlobalKey<FormState>();

    await showDialog<void>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(builder: (ctx, setStateDialog) {
          String? brand;
          final digits = cardNum.text.replaceAll(RegExp(r'\D'), '');
          if (digits.startsWith('4')) {
            brand = 'Visa';
          } else if (digits.startsWith(RegExp(r'^(5[1-5]|2(2[2-9]|[3-6]\d|7[01])|720)'))) {
            brand = 'Mastercard';
          } else if (digits.startsWith(RegExp(r'^3[47]'))) {
            brand = 'Amex';
          } else if (digits.startsWith(RegExp(r'^(6011|65|64[4-9]|622)'))) {
            brand = 'Discover';
          }
          return AlertDialog(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            title: const Text('Add payout card', style: TextStyle(fontWeight: FontWeight.w800)),
            content: SingleChildScrollView(
              child: Form(
                key: formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'Your card is only used to receive payouts. We never store the full card number or security code.',
                      style: TextStyle(fontSize: 12, color: Color(0xFF6B6B6B), height: 1.35),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: cardNum,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: 'Card number',
                        suffixText: brand,
                      ),
                      onChanged: (_) => setStateDialog(() {}),
                      validator: (v) {
                        final d = (v ?? '').replaceAll(RegExp(r'\D'), '');
                        if (d.length < 13 || d.length > 19) return 'Enter a valid card number';
                        if (!_luhnOk(d)) return 'That card number isn\'t valid';
                        return null;
                      },
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: TextFormField(
                            controller: expM,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(labelText: 'Exp. MM'),
                            validator: (v) {
                              final n = int.tryParse((v ?? '').trim());
                              if (n == null || n < 1 || n > 12) return '1-12';
                              return null;
                            },
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: TextFormField(
                            controller: expY,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(labelText: 'Exp. YYYY'),
                            validator: (v) {
                              final n = int.tryParse((v ?? '').trim());
                              if (n == null || n < 2025 || n > 2099) return '2025-2099';
                              return null;
                            },
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: name,
                      decoration: const InputDecoration(labelText: 'Cardholder name'),
                      validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: zip,
                      decoration: const InputDecoration(labelText: 'ZIP / Postal code'),
                      validator: (v) => (v == null || v.trim().length < 3) ? 'Required' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: cvc,
                      keyboardType: TextInputType.number,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: 'Security code (CVC)'),
                      validator: (v) {
                        final d = (v ?? '').trim();
                        if (d.length < 3 || d.length > 4) return '3-4 digits';
                        return null;
                      },
                    ),
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              FilledButton(
                onPressed: () async {
                  if (!(formKey.currentState?.validate() ?? false)) return;
                  try {
                    await UserService.addPayoutCard({
                      'card_number': cardNum.text.replaceAll(RegExp(r'\D'), ''),
                      'exp_month': int.parse(expM.text.trim()),
                      'exp_year': int.parse(expY.text.trim()),
                      'cardholder_name': name.text.trim(),
                      'zip': zip.text.trim(),
                      'cvc': cvc.text.trim(),
                    });
                    if (mounted) {
                      Navigator.pop(ctx);
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(
                          content: Text('Card submitted — awaiting admin approval.'),
                          backgroundColor: Color(0xFF5B7760),
                        ),
                      );
                      setState(() {});
                    }
                  } catch (e) {
                    final msg = _friendlyError(e.toString());
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text(msg), backgroundColor: const Color(0xFFC65A5A)),
                      );
                    }
                  }
                },
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF5B7760),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: const Text('Submit for review'),
              ),
            ],
          );
        });
      },
    );
  }

  // ----- On-demand payout dialog (5% fee preview) -------------------------

  Future<void> _showRequestPayoutDialog() async {
    final amount = TextEditingController();
    final w = await UserService.getWallet();
    final balanceCents = (w['balance_cents'] as num?)?.toInt() ?? 0;
    if (!mounted) return;

    await showDialog<void>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(builder: (ctx, setStateDialog) {
          final rawCents = ((double.tryParse(amount.text.replaceAll(',', '').replaceAll('\$', '')) ?? 0) * 100).round();
          final feeCents = (rawCents * 0.05).round();
          final netCents = rawCents - feeCents;
          final tooSmall = rawCents < 500; // $5 minimum
          final tooLarge = rawCents > balanceCents;
          final canSubmit = rawCents > 0 && !tooSmall && !tooLarge;
          String? validation;
          if (rawCents > 0 && tooSmall) validation = 'Minimum payout is \$5.00';
          if (rawCents > 0 && tooLarge) validation = 'Amount exceeds your balance';
          return AlertDialog(
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            title: const Text('Request payout', style: TextStyle(fontWeight: FontWeight.w800)),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Available: ${NumberFormat.simpleCurrency(name: 'USD').format(balanceCents / 100)}',
                    style: const TextStyle(fontSize: 12, color: Color(0xFF6B6B6B))),
                const SizedBox(height: 12),
                TextField(
                  controller: amount,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(
                    labelText: 'Amount (USD)',
                    prefixText: '\$ ',
                    errorText: validation,
                  ),
                  onChanged: (_) => setStateDialog(() {}),
                ),
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF6F7F4),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    children: [
                      _kv('Amount', NumberFormat.simpleCurrency(name: 'USD').format(rawCents / 100)),
                      const SizedBox(height: 4),
                      _kv('On-demand fee (5%)', '- ${NumberFormat.simpleCurrency(name: 'USD').format(feeCents / 100)}',
                          color: const Color(0xFFC65A5A)),
                      const Divider(height: 18),
                      _kv('You\'ll receive', NumberFormat.simpleCurrency(name: 'USD').format(netCents / 100),
                          bold: true),
                      const SizedBox(height: 6),
                      const Text(
                        'Tip: weekly auto-payouts on Mondays have no fee.',
                        style: TextStyle(fontSize: 11, color: Color(0xFF6B6B6B)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              FilledButton(
                onPressed: !canSubmit
                    ? null
                    : () async {
                        try {
                          await UserService.requestOnDemandPayout(rawCents);
                          if (mounted) {
                            Navigator.pop(ctx);
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text('Payout requested. An admin will process it shortly.'),
                                backgroundColor: Color(0xFF5B7760),
                              ),
                            );
                            setState(() {});
                          }
                        } catch (e) {
                          final msg = _friendlyError(e.toString());
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text(msg), backgroundColor: const Color(0xFFC65A5A)),
                            );
                          }
                        }
                      },
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF5B7760),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: const Text('Request payout'),
              ),
            ],
          );
        });
      },
    );
  }

  Widget _kv(String k, String v, {bool bold = false, Color? color}) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(k, style: TextStyle(fontSize: 13, color: color ?? const Color(0xFF2F3A32), fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
        Text(v,
            style: TextStyle(fontSize: 13, color: color ?? const Color(0xFF2F3A32), fontWeight: bold ? FontWeight.w800 : FontWeight.w700)),
      ],
    );
  }

  /// Standard Luhn check for client-side validation. Server re-validates
  /// and discards the PAN immediately; this is purely a UX gate.
  bool _luhnOk(String digits) {
    if (digits.length < 13 || digits.length > 19) return false;
    int sum = 0;
    bool alt = false;
    for (int i = digits.length - 1; i >= 0; i--) {
      int d = int.parse(digits[i]);
      if (alt) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alt = !alt;
    }
    return sum % 10 == 0;
  }

  /// Tiny helper reused for rows inside the Wallet card so we don't have
  /// to invent a new component for this section.
  Widget _buildProfileRow({
    required IconData icon,
    required String title,
    Widget? trailing,
  }) {
    return Row(
      children: [
        Icon(icon, size: 20, color: const Color(0xFF2F3A32).withOpacity(0.6)),
        const SizedBox(width: 12),
        Expanded(child: Text(title, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
        if (trailing != null) trailing,
      ],
    );
  }
}
