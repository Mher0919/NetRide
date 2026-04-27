import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'dart:io';
import 'dart:math' as math;
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
  final _emailController = TextEditingController();
  String _email = '';
  String? _profileImageUrl;
  bool _isLoading = true;
  bool _isSaving = false;
  bool _isEditing = false;
  bool _isVerified = false;

  // Local state for verification
  File? _pickedIdFront;
  File? _pickedIdBack;
  String? _pendingDob;

  @override
  void initState() {
    super.initState();
    _fetchProfile();
  }

  Future<void> _fetchProfile() async {
    try {
      final profile = await UserService.getProfile();
      setState(() {
        _nameController.text = profile['full_name'] ?? '';
        _phoneController.text = profile['phone_number'] ?? '';
        _dobController.text = profile['date_of_birth'] != null 
            ? DateFormat('MM-dd-yyyy').format(DateTime.parse(profile['date_of_birth']))
            : '';
        _email = profile['email'] ?? '';
        _emailController.text = _email;
        _profileImageUrl = profile['profile_image_url'];
        _isVerified = profile['is_verified'] == true || profile['is_verified'] == 'true';
        _isLoading = false;
      });
    } catch (e) {
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

  Future<void> _updateAgeAndVerify() async {
    // 1. Pick new DOB
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: DateTime.now().subtract(const Duration(days: 365 * 18)),
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
        title: Text('ID Verification (Step 1/2)', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.badge_outlined, size: 80, color: Colors.blue),
            const SizedBox(height: 16),
            Text('Please select a clear picture of the FRONT of your ID card.', textAlign: TextAlign.center, style: GoogleFonts.poppins()),
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
        title: Text('ID Verification (Step 2/2)', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
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
            Text('Now, please select a clear picture of the BACK of your ID card.', textAlign: TextAlign.center, style: GoogleFonts.poppins()),
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
            Text('Are you sure you want to submit these photos for age verification?', textAlign: TextAlign.center, style: GoogleFonts.poppins()),
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

      await ApiService.dio.post('/user/verify-identity', data: {
        'id_photo_front_url': frontUrl,
        'id_photo_back_url': backUrl,
        'date_of_birth': newDob,
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
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.black),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text('Profile', style: GoogleFonts.poppins(color: Colors.black, fontWeight: FontWeight.bold)),
        actions: [
          if (!_isLoading)
            Padding(
              padding: const EdgeInsets.only(right: 12.0),
              child: IconButton(
                icon: Icon(_isEditing ? Icons.close : Icons.edit, color: Colors.black, size: 28),
                onPressed: () => setState(() => _isEditing = !_isEditing),
              ),
            ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator(color: Colors.black))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(24.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Column(
                      children: [
                        Stack(
                          children: [
                            CircleAvatar(
                              radius: 50,
                              backgroundColor: Colors.grey[200],
                              backgroundImage: _profileImageUrl != null ? NetworkImage(_profileImageUrl!) : null,
                              child: _profileImageUrl == null ? const Icon(Icons.person, size: 50, color: Colors.grey) : null,
                            ),
                            if (_isEditing)
                              Positioned(
                                bottom: 0,
                                right: 0,
                                child: CircleAvatar(
                                  radius: 18,
                                  backgroundColor: Colors.black,
                                  child: IconButton(
                                    icon: const Icon(Icons.camera_alt, size: 16, color: Colors.white),
                                    onPressed: _changeProfilePicture,
                                  ),
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color: _isVerified ? Colors.green.withOpacity(0.1) : Colors.red.withOpacity(0.1),
                            borderRadius: BorderRadius.circular(20),
                            border: Border.all(color: _isVerified ? Colors.green : Colors.red),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                _isVerified ? Icons.verified : Icons.error_outline,
                                size: 16,
                                color: _isVerified ? Colors.green : Colors.red,
                              ),
                              const SizedBox(width: 6),
                              Text(
                                _isVerified ? 'VERIFIED RIDER' : 'UNVERIFIED',
                                style: GoogleFonts.poppins(
                                  fontSize: 12,
                                  fontWeight: FontWeight.bold,
                                  color: _isVerified ? Colors.green : Colors.red,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 32),
                  _buildSectionTitle('Personal Information'),
                  const SizedBox(height: 16),
                  _buildTextField(
                    label: 'Full Name',
                    controller: _nameController,
                    enabled: _isEditing,
                    icon: Icons.person_outline,
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: _buildTextField(
                          label: 'Email',
                          controller: TextEditingController(text: _email),
                          enabled: false,
                          icon: Icons.email_outlined,
                        ),
                      ),
                      if (_isEditing)
                        IconButton(
                          icon: const Icon(Icons.edit, color: Colors.blue, size: 20),
                          onPressed: _showEmailChangeDialog,
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _buildTextField(
                    label: 'Phone Number',
                    controller: _phoneController,
                    enabled: _isEditing,
                    icon: Icons.phone_outlined,
                    keyboardType: TextInputType.phone,
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: _buildTextField(
                          label: 'Date of Birth',
                          controller: _dobController,
                          enabled: false, 
                          icon: Icons.cake_outlined,
                          hint: 'MM-DD-YYYY',
                        ),
                      ),
                      const SizedBox(width: 16),
                      if (_isEditing)
                        TextButton.icon(
                          onPressed: _isSaving ? null : _updateAgeAndVerify,
                          icon: const Icon(Icons.edit_calendar_outlined, size: 18),
                          label: const Text('Change'),
                          style: TextButton.styleFrom(foregroundColor: Colors.blue),
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Center(
                    child: Padding(
                      padding: const EdgeInsets.only(top: 8.0),
                      child: Text('Age: ${_calculateAge(_dobController.text)}', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
                    ),
                  ),

                  const SizedBox(height: 32),
                  _buildSectionTitle('Account Security'),
                  const SizedBox(height: 16),
                  ListTile(
                    leading: const Icon(Icons.lock_outline),
                    title: const Text('Change Password'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _showChangePasswordDialog,
                  ),
                  const SizedBox(height: 32),
                  _buildSectionTitle('Payment Methods'),
                  const SizedBox(height: 16),
                  _buildPaymentCard('•••• 4242', 'Visa', Icons.credit_card),
                  const SizedBox(height: 32),
                  if (_isEditing)
                    SizedBox(
                      width: double.infinity,
                      height: 56,
                      child: ElevatedButton(
                        onPressed: _isSaving ? null : _saveProfile,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.black,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                        child: _isSaving
                            ? const CircularProgressIndicator(color: Colors.white)
                            : Text('Save Changes', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
                      ),
                    ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    height: 56,
                    child: OutlinedButton(
                      onPressed: _handleLogout,
                      style: OutlinedButton.styleFrom(
                        side: const BorderSide(color: Colors.red),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      child: Text(
                        'Logout',
                        style: GoogleFonts.poppins(color: Colors.red, fontWeight: FontWeight.bold),
                      ),
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _buildSectionTitle(String title) {
    return Text(
      title,
      style: GoogleFonts.poppins(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.black),
    );
  }

  Widget _buildTextField({
    required String label,
    required TextEditingController controller,
    required bool enabled,
    required IconData icon,
    TextInputType? keyboardType,
    String? hint,
  }) {
    return TextField(
      controller: controller,
      enabled: enabled,
      keyboardType: keyboardType,
      style: GoogleFonts.poppins(fontSize: 16),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        prefixIcon: Icon(icon, color: Colors.grey),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        disabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: Colors.grey[300]!),
        ),
      ),
    );
  }

  Widget _buildPaymentCard(String last4, String type, IconData icon) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        border: Border.all(color: Colors.grey[200]!),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(icon, color: Colors.black),
          const SizedBox(width: 16),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(type, style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
              Text(last4, style: GoogleFonts.poppins(color: Colors.grey)),
            ],
          ),
          const Spacer(),
          const Icon(Icons.chevron_right, color: Colors.grey),
        ],
      ),
    );
  }
}
