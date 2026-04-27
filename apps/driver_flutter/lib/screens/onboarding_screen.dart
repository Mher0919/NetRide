import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import '../services/auth_service.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final PageController _pageController = PageController();
  int _currentStep = 0;
  bool _isSubmitting = false;

  // Form Data
  final _nameController = TextEditingController();
  final _phoneController = TextEditingController();
  final _dobController = TextEditingController();
  String? _profileImageUrl;

  final _licenseNumberController = TextEditingController();
  final _licenseExpiryController = TextEditingController();
  String? _licensePhotoFrontUrl;
  String? _licensePhotoBackUrl;

  String? _selectedVehicleId;
  final _plateNumberController = TextEditingController();
  String? _platePhotoUrl;
  final List<String> _carPhotoUrls = [];

  List<dynamic> _availableVehicles = [];

  @override
  void initState() {
    super.initState();
    _fetchVehicles();
  }

  Future<void> _fetchVehicles() async {
    try {
      final vehicles = await AuthService.getVehicles();
      setState(() => _availableVehicles = vehicles);
    } catch (e) {
      debugPrint('Error fetching vehicles: $e');
    }
  }

  Future<void> _pickImage(Function(String) onUpload) async {
    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(source: ImageSource.gallery);
    if (pickedFile != null) {
      // Show loading
      final url = await AuthService.uploadImage(File(pickedFile.path));
      onUpload(url);
      setState(() {});
    }
  }

  bool _validateAge(String dob) {
    if (dob.isEmpty) return false;
    try {
      final birthDate = DateTime.parse(dob);
      final today = DateTime.now();
      int age = today.year - birthDate.year;
      if (today.month < birthDate.month || (today.month == birthDate.month && today.day < birthDate.day)) {
        age--;
      }
      return age >= 21;
    } catch (e) {
      return false;
    }
  }

  void _nextStep() {
    if (_currentStep == 0) {
      if (_profileImageUrl == null) {
        _showError('Profile picture is mandatory for drivers');
        return;
      }
      if (!_validateAge(_dobController.text)) {
        _showError('Drivers must be at least 21 years old (YYYY-MM-DD)');
        return;
      }
      if (_nameController.text.isEmpty || _phoneController.text.isEmpty) {
        _showError('Please fill in all personal info');
        return;
      }
    } else if (_currentStep == 1) {
      if (_licensePhotoFrontUrl == null || _licensePhotoBackUrl == null) {
        _showError('Both front and back photos of your driver license are mandatory');
        return;
      }
      if (_licenseNumberController.text.isEmpty || _licenseExpiryController.text.isEmpty) {
        _showError('Please fill in license details');
        return;
      }
    }

    if (_currentStep < 3) {
      _pageController.nextPage(
        duration: const Duration(milliseconds: 400),
        curve: Curves.easeInOut,
      );
    }
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  void _prevStep() {
    if (_currentStep > 0) {
      _pageController.previousPage(
        duration: const Duration(milliseconds: 400),
        curve: Curves.easeInOut,
      );
    }
  }

  Future<void> _submit() async {
    setState(() => _isSubmitting = true);
    try {
      final onboardData = {
        'personalInfo': {
          'full_name': _nameController.text,
          'phone_number': _phoneController.text,
          'date_of_birth': _dobController.text,
          'profile_image_url': _profileImageUrl ?? "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d",
        },
        'identity': {
          'license_number': _licenseNumberController.text,
          'license_expiry_date': _licenseExpiryController.text,
          'license_photo_url': _licensePhotoFrontUrl,
          'license_photo_back_url': _licensePhotoBackUrl,
        },
        'vehicle': {
          'vehicle_id': _selectedVehicleId ?? _availableVehicles.first['id'],
          'license_plate_number': _plateNumberController.text,
          'license_plate_photo_url': _platePhotoUrl ?? "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d",
          'car_photo_urls': _carPhotoUrls.isNotEmpty ? _carPhotoUrls : ["https://images.unsplash.com/photo-1449965408869-eaa3f722e40d", "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d"],
        },
      };

      await AuthService.onboardDriver(onboardData);
      if (mounted) {
        Navigator.pushReplacementNamed(context, '/success');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Onboarding failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        leading: _currentStep > 0
            ? IconButton(
                icon: const Icon(Icons.arrow_back, color: Colors.black),
                onPressed: _prevStep,
              )
            : null,
        title: _StepIndicator(currentStep: _currentStep),
      ),
      body: PageView(
        controller: _pageController,
        physics: const NeverScrollableScrollPhysics(),
        onPageChanged: (idx) => setState(() => _currentStep = idx),
        children: [
          _buildPersonalInfoStep(),
          _buildIdentityStep(),
          _buildVehicleStep(),
          _buildReviewStep(),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: SizedBox(
            height: 56,
            child: ElevatedButton(
              onPressed: _isSubmitting ? null : (_currentStep == 3 ? _submit : _nextStep),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.black,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: _isSubmitting
                  ? const CircularProgressIndicator(color: Colors.white)
                  : Text(
                      _currentStep == 3 ? 'Submit Application' : 'Next Step',
                      style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPersonalInfoStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Personal Info', style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 24),
          Center(
            child: GestureDetector(
              onTap: () => _pickImage((url) => _profileImageUrl = url),
              child: CircleAvatar(
                radius: 50,
                backgroundColor: Colors.grey[200],
                backgroundImage: _profileImageUrl != null ? NetworkImage(_profileImageUrl!) : null,
                child: _profileImageUrl == null ? const Icon(Icons.add_a_photo, size: 32, color: Colors.grey) : null,
              ),
            ),
          ),
          const SizedBox(height: 24),
          _buildTextField(label: 'Full Name', controller: _nameController),
          const SizedBox(height: 16),
          _buildTextField(label: 'Phone Number', controller: _phoneController, keyboardType: TextInputType.phone),
          const SizedBox(height: 16),
          _buildTextField(label: 'Date of Birth', controller: _dobController, hint: 'YYYY-MM-DD'),
        ],
      ),
    );
  }

  Widget _buildIdentityStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Identity', style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 24),
          _buildTextField(label: 'Driver License Number', controller: _licenseNumberController),
          const SizedBox(height: 16),
          _buildTextField(label: 'License Expiry', controller: _licenseExpiryController, hint: 'YYYY-MM-DD'),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(
                child: _buildImagePickerBox(
                  label: 'License Front',
                  imageUrl: _licensePhotoFrontUrl,
                  onTap: () => _pickImage((url) => _licensePhotoFrontUrl = url),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: _buildImagePickerBox(
                  label: 'License Back',
                  imageUrl: _licensePhotoBackUrl,
                  onTap: () => _pickImage((url) => _licensePhotoBackUrl = url),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildVehicleStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Vehicle', style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 24),
          DropdownButtonFormField<String>(
            value: _selectedVehicleId,
            decoration: _inputDecoration('Select Vehicle Model'),
            items: _availableVehicles.map((v) {
              return DropdownMenuItem<String>(
                value: v['id'],
                child: Text('${v['year']} ${v['make']} ${v['model']}'),
              );
            }).toList(),
            onChanged: (val) => setState(() => _selectedVehicleId = val),
          ),
          const SizedBox(height: 16),
          _buildTextField(label: 'License Plate Number', controller: _plateNumberController),
          const SizedBox(height: 24),
          _buildImagePickerBox(
            label: 'License Plate Photo',
            imageUrl: _platePhotoUrl,
            onTap: () => _pickImage((url) => _platePhotoUrl = url),
          ),
          const SizedBox(height: 16),
          Text('Car Photos (min 2)', style: GoogleFonts.poppins(fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          GridView.count(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisCount: 3,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            children: [
              ..._carPhotoUrls.map((url) => Image.network(url, fit: BoxFit.cover)),
              if (_carPhotoUrls.length < 4)
                GestureDetector(
                  onTap: () => _pickImage((url) => _carPhotoUrls.add(url)),
                  child: Container(
                    color: Colors.grey[100],
                    child: const Icon(Icons.add),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildReviewStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Review', style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 24),
          _ReviewItem(label: 'Name', value: _nameController.text),
          _ReviewItem(label: 'Phone', value: _phoneController.text),
          _ReviewItem(label: 'License', value: _licenseNumberController.text),
          _ReviewItem(label: 'Plate', value: _plateNumberController.text),
          const SizedBox(height: 24),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: Colors.yellow[50], borderRadius: BorderRadius.circular(12)),
            child: const Text(
              'By submitting, you agree to a background check. Review takes 1-3 business days.',
              style: TextStyle(fontSize: 12, color: Colors.orange),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTextField({required String label, required TextEditingController controller, TextInputType? keyboardType, String? hint}) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      decoration: _inputDecoration(label).copyWith(hintText: hint),
    );
  }

  InputDecoration _inputDecoration(String label) {
    return InputDecoration(
      labelText: label,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Colors.black, width: 2),
      ),
    );
  }

  Widget _buildImagePickerBox({required String label, String? imageUrl, required VoidCallback onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: double.infinity,
        height: 120,
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey[300]!),
          borderRadius: BorderRadius.circular(12),
          image: imageUrl != null ? DecorationImage(image: NetworkImage(imageUrl), fit: BoxFit.cover) : null,
        ),
        child: imageUrl == null
            ? Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.cloud_upload_outlined, color: Colors.grey),
                  const SizedBox(height: 8),
                  Text(label, style: const TextStyle(color: Colors.grey)),
                ],
              )
            : null,
      ),
    );
  }
}

class _StepIndicator extends StatelessWidget {
  final int currentStep;
  const _StepIndicator({required this.currentStep});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(4, (index) {
        return Container(
          width: 20,
          height: 4,
          margin: const EdgeInsets.symmetric(horizontal: 4),
          decoration: BoxDecoration(
            color: index <= currentStep ? Colors.black : Colors.grey[200],
            borderRadius: BorderRadius.circular(2),
          ),
        );
      }),
    );
  }
}

class _ReviewItem extends StatelessWidget {
  final String label, value;
  const _ReviewItem({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12.0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Colors.grey)),
          Text(value, style: const TextStyle(fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}
