import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:image_picker/image_picker.dart';
import 'dart:io';
import 'dart:math' as math;
import 'package:shared_preferences/shared_preferences.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';

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
  bool _isLoading = true;
  bool _isSaving = false;
  bool _isEditing = false;
  bool _isVerified = false;

  // Local state for verification
  File? _pickedLicenseFront;
  File? _pickedLicenseBack;
  String? _pendingDob;

  @override
  void initState() {
    super.initState();
    _fetchProfile();
  }

  Future<void> _fetchProfile() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('jwt_token');
      if (token == null) {
        if (mounted) setState(() => _isLoading = false);
        return;
      }

      final profile = await UserService.getProfile();
      final vehicles = await UserService.getVehicles();
      
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
        
        if (profile['vehicles'] != null && profile['vehicles'].isNotEmpty) {
          final v = profile['vehicles'][0];
          _selectedVehicleId = v['vehicle_id'];
          _plateController.text = v['license_plate_number'] ?? '';
        }
        
        _vehicles = vehicles;
        _isLoading = false;
      });
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 404) {
        debugPrint('User not found (404), logging out...');
        await AuthService.logout();
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        }
        return;
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to load profile: $e')),
        );
      }
    }
  }

  Future<void> _changeProfilePicture() async {
    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(source: ImageSource.gallery);
    if (pickedFile != null) {
      setState(() => _isSaving = true);
      try {
        final url = await AuthService.uploadImage(File(pickedFile.path));
        await UserService.updateProfile({'profile_image_url': url});
        setState(() {
          _profileImageUrl = url;
          _isSaving = false;
        });
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Profile picture updated')));
        }
      } catch (e) {
        setState(() => _isSaving = false);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed to upload image: $e')));
        }
      }
    }
  }

  Future<void> _updateAgeAndLicense() async {
    // 1. Pick new DOB
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
    
    // 2. Ask for Front
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

    // 3. Ask for Back
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

    // 4. Confirm and Submit
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

  Widget _buildImageUploadBox({required String label, File? file, required VoidCallback onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 120,
        decoration: BoxDecoration(
          color: Colors.grey[50],
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.grey[300]!, style: BorderStyle.solid),
          image: file != null ? DecorationImage(image: FileImage(file), fit: BoxFit.cover) : null,
        ),
        child: file == null
            ? Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.add_a_photo_outlined, color: Colors.grey, size: 32),
                  const SizedBox(height: 8),
                  Text(label, style: GoogleFonts.poppins(color: Colors.grey, fontSize: 12)),
                ],
              )
            : Container(
                alignment: Alignment.bottomRight,
                padding: const EdgeInsets.all(8),
                child: const CircleAvatar(
                  backgroundColor: Colors.black,
                  radius: 12,
                  child: Icon(Icons.check, size: 16, color: Colors.white),
                ),
              ),
      ),
    );
  }

  Future<void> _showChangePasswordDialog() async {
    final currentPasswordController = TextEditingController();
    final newPasswordController = TextEditingController();
    final confirmPasswordController = TextEditingController();
    bool obscure = true;

    await showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text('Change Password', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: currentPasswordController,
                obscureText: obscure,
                decoration: InputDecoration(
                  labelText: 'Current Password',
                  suffixIcon: IconButton(
                    icon: Icon(obscure ? Icons.visibility_off : Icons.visibility),
                    onPressed: () => setDialogState(() => obscure = !obscure),
                  ),
                ),
              ),
              TextField(
                controller: newPasswordController,
                obscureText: obscure,
                decoration: const InputDecoration(labelText: 'New Password'),
              ),
              TextField(
                controller: confirmPasswordController,
                obscureText: obscure,
                decoration: const InputDecoration(labelText: 'Confirm New Password'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () async {
                try {
                  await AuthService.forgotPassword(_email);
                  if (mounted) {
                    Navigator.pop(context);
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Reset link sent to your email')));
                  }
                } catch (e) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              },
              child: const Text('Forgot?', style: TextStyle(color: Colors.blue)),
            ),
            const Spacer(),
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                if (newPasswordController.text != confirmPasswordController.text) {
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Passwords do not match')));
                  return;
                }
                try {
                  await AuthService.changePassword(
                    currentPassword: currentPasswordController.text,
                    newPassword: newPasswordController.text,
                  );
                  if (mounted) {
                    Navigator.pop(context);
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Password changed successfully')));
                  }
                } catch (e) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              },
              style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
              child: const Text('Change'),
            ),
          ],
        ),
      ),
    );
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

  Future<void> _saveProfile() async {
    setState(() => _isSaving = true);
    try {
      await UserService.updateProfile({
        'full_name': _nameController.text.trim(),
        'phone_number': _phoneController.text.trim(),
        if (_selectedVehicleId != null) 'vehicle_id': _selectedVehicleId,
        'license_plate_number': _plateController.text.trim(),
      });

      setState(() {
        _isSaving = false;
        _isEditing = false;
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Profile updated successfully')),
        );
        _fetchProfile();
      }
    } catch (e) {
      setState(() => _isSaving = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to update profile: $e')),
        );
      }
    }
  }

  int _calculateAge(String dob) {
    if (dob.isEmpty) return 0;
    try {
      DateTime birthDate;
      if (dob.contains('-') && dob.split('-')[0].length == 4) {
        birthDate = DateTime.parse(dob);
      } else {
        birthDate = DateFormat('MM-dd-yyyy').parse(dob);
      }
      final today = DateTime.now();
      int age = today.year - birthDate.year;
      if (today.month < birthDate.month || (today.month == birthDate.month && today.day < birthDate.day)) {
        age--;
      }
      return age;
    } catch (e) {
      return 0;
    }
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
        title: Text(
          'Account',
          style: theme.textTheme.headlineMedium?.copyWith(fontSize: 24),
        ),
        actions: [
          if (!_isLoading)
            Padding(
              padding: const EdgeInsets.only(right: 12.0),
              child: IconButton(
                icon: Icon(_isEditing ? Icons.check_circle_outline : Icons.edit_outlined, color: const Color(0xFF5B7760)),
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
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
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
                    title: 'License & Vehicle',
                    children: [
                      _buildProfileItem(
                        icon: Icons.badge_outlined,
                        label: 'License Number',
                        controller: _licenseController,
                        enabled: _isEditing,
                      ),
                      const Divider(height: 32),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Vehicle Model',
                            style: TextStyle(
                              fontSize: 12,
                              color: const Color(0xFF2F3A32).withOpacity(0.4),
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          const SizedBox(height: 8),
                          DropdownButtonFormField<String>(
                            value: _selectedVehicleId,
                            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFF2F3A32)),
                            decoration: const InputDecoration(
                              isDense: true,
                              contentPadding: EdgeInsets.zero,
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              filled: false,
                            ),
                            items: _vehicles.map((v) {
                              return DropdownMenuItem<String>(
                                value: v['id'],
                                child: Text('${v['year']} ${v['make']} ${v['model']}'),
                              );
                            }).toList(),
                            onChanged: _isEditing ? (val) => setState(() => _selectedVehicleId = val) : null,
                          ),
                        ],
                      ),
                      const Divider(height: 32),
                      _buildProfileItem(
                        icon: Icons.vpn_key_outlined,
                        label: 'License Plate',
                        controller: _plateController,
                        enabled: _isEditing,
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  _buildSectionCard(
                    title: 'Security',
                    children: [
                      _buildMenuTile(
                        icon: Icons.lock_outline_rounded,
                        title: 'Password & Security',
                        onTap: _showChangePasswordDialog,
                      ),
                    ],
                  ),
                  const SizedBox(height: 40),
                  SizedBox(
                    width: double.infinity,
                    child: TextButton(
                      onPressed: _handleLogout,
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        foregroundColor: const Color(0xFFC65A5A),
                      ),
                      child: const Text('Logout', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                    ),
                  ),
                ],
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
                child: CircleAvatar(
                  radius: 50,
                  backgroundColor: const Color(0xFFF7F4EF),
                  backgroundImage: _profileImageUrl != null ? NetworkImage(_profileImageUrl!) : null,
                  child: _profileImageUrl == null ? const Icon(Icons.drive_eta, size: 48, color: Color(0xFF5B7760)) : null,
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
          const SizedBox(height: 16),
          Container(
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
  }) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Row(
        children: [
          Icon(icon, size: 20, color: const Color(0xFF2F3A32).withOpacity(0.4)),
          const SizedBox(width: 16),
          Expanded(
            child: Text(
              title,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFF2F3A32)),
            ),
          ),
          if (trailing != null) trailing,
          const SizedBox(width: 8),
          Icon(Icons.chevron_right_rounded, size: 20, color: const Color(0xFF2F3A32).withOpacity(0.2)),
        ],
      ),
    );
  }
}
