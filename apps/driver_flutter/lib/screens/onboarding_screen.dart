import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import '../services/auth_service.dart';
import '../data/cars_data.dart';

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
  String? _insurancePhotoUrl;
  String? _registrationPhotoUrl;

  String? _selectedVehicleId; // Category ID
  String? _selectedCarMake;
  String? _selectedCarModel;
  String? _selectedColor;
  bool _hasBlackInterior = false;
  final _plateNumberController = TextEditingController();
  String? _platePhotoUrl;
  final List<String> _carPhotoUrls = [];

  List<dynamic> _availableCategories = [];

  final List<String> _colors = [
    'Black', 'White', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Brown', 'Beige', 'Gold', 'Other'
  ];

  @override
  void initState() {
    super.initState();
    _fetchCategories();
  }

  Future<void> _fetchCategories() async {
    try {
      final vehicles = await AuthService.getVehicles();
      setState(() => _availableCategories = vehicles);
    } catch (e) {
      debugPrint('Error fetching categories: $e');
    }
  }

  Future<void> _pickImage(Function(String) onUpload) async {
    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (pickedFile != null) {
      try {
        final url = await AuthService.uploadImage(File(pickedFile.path));
        onUpload(url);
        if (mounted) setState(() {});
      } catch (e) {
        if (mounted) _showError('Upload failed: $e');
      }
    }
  }

  bool _validateAge(String dob) {
    if (dob.isEmpty) return false;
    try {
      final birthDate = DateFormat('yyyy-MM-dd').parse(dob);
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
        _showError('Profile picture is mandatory');
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
        _showError('Both front and back photos of your license are mandatory');
        return;
      }
      if (_insurancePhotoUrl == null) {
        _showError('Insurance photo is mandatory');
        return;
      }
      if (_registrationPhotoUrl == null) {
        _showError('Car registration photo is mandatory');
        return;
      }
      if (_licenseNumberController.text.isEmpty || _licenseExpiryController.text.isEmpty) {
        _showError('Please fill in license details');
        return;
      }
    } else if (_currentStep == 2) {
      if (_selectedVehicleId == null) {
        _showError('Please select a ride category');
        return;
      }
      if (_selectedCarMake == null || _selectedCarModel == null) {
        _showError('Please select your car make and model');
        return;
      }
      if (_selectedColor == null) {
        _showError('Please select your car color');
        return;
      }
      if (_plateNumberController.text.isEmpty) {
        _showError('Please enter license plate number');
        return;
      }

      final category = _availableCategories.firstWhere((c) => c['id'] == _selectedVehicleId, orElse: () => null);
      if (category != null && category['model'] == 'Premier') {
        if (_selectedColor != 'Black') {
          _showError('NetRide Premier requires a Black exterior color');
          return;
        }
        if (!_hasBlackInterior) {
          _showError('NetRide Premier requires a Black interior confirmation');
          return;
        }
      }

      if (_platePhotoUrl == null) {
        _showError('License plate photo is mandatory');
        return;
      }
      if (_carPhotoUrls.length < 2) {
        _showError('Please upload at least 2 photos of your car');
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
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: Colors.redAccent,
      ),
    );
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
          'profile_image_url': _profileImageUrl,
        },
        'identity': {
          'license_number': _licenseNumberController.text,
          'license_expiry_date': _licenseExpiryController.text,
          'license_photo_url': _licensePhotoFrontUrl,
          'license_photo_back_url': _licensePhotoBackUrl,
          'insurance_photo_url': _insurancePhotoUrl,
          'registration_photo_url': _registrationPhotoUrl,
        },
        'vehicle': {
          'vehicle_id': _selectedVehicleId,
          'license_plate_number': _plateNumberController.text,
          'license_plate_photo_url': _platePhotoUrl,
          'car_photo_urls': _carPhotoUrls,
          'color': _selectedColor,
          'interior_color': _hasBlackInterior ? 'Black' : 'Other',
          'make': _selectedCarMake,
          'model': _selectedCarModel,
        },
      };

      await AuthService.onboardDriver(onboardData);
      if (mounted) {
        Navigator.pushReplacementNamed(context, '/success');
      }
    } catch (e) {
      if (mounted) {
        _showError('Onboarding failed: $e');
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFEEEBE6),
      appBar: AppBar(
        backgroundColor: const Color(0xFFEEEBE6),
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
          const SizedBox(height: 8),
          Text('Your profile picture and age are mandatory.', style: GoogleFonts.poppins(fontSize: 14, color: Colors.grey[600])),
          const SizedBox(height: 24),
          Center(
            child: GestureDetector(
              onTap: () => _pickImage((url) => _profileImageUrl = url),
              child: CircleAvatar(
                radius: 60,
                backgroundColor: Colors.grey[100],
                backgroundImage: _profileImageUrl != null ? NetworkImage(_profileImageUrl!) : null,
                child: _profileImageUrl == null 
                  ? Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.add_a_photo_outlined, size: 32, color: Colors.grey),
                        const SizedBox(height: 4),
                        Text('Profile Pic', style: GoogleFonts.poppins(fontSize: 12, color: Colors.grey)),
                      ],
                    )
                  : null,
              ),
            ),
          ),
          const SizedBox(height: 32),
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
          Text('Identity & Docs', style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          Text('Upload clear photos of your documents.', style: GoogleFonts.poppins(fontSize: 14, color: Colors.grey[600])),
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
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: _buildImagePickerBox(
                  label: 'Insurance',
                  imageUrl: _insurancePhotoUrl,
                  onTap: () => _pickImage((url) => _insurancePhotoUrl = url),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: _buildImagePickerBox(
                  label: 'Car Registration',
                  imageUrl: _registrationPhotoUrl,
                  onTap: () => _pickImage((url) => _registrationPhotoUrl = url),
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
          
          Text('Ride Category', style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          _buildCategorySelector(),
          
          const SizedBox(height: 24),
          Text('Car Make & Model', style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          _buildCarPicker(),

          const SizedBox(height: 24),
          Text('Car Exterior Color', style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          _buildColorPicker(),

          if (_isPremierSelected()) ...[
            const SizedBox(height: 16),
            CheckboxListTile(
              title: Text('I confirm my car has a Black Interior', style: GoogleFonts.poppins(fontSize: 14)),
              value: _hasBlackInterior,
              onChanged: (val) => setState(() => _hasBlackInterior = val ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              activeColor: Colors.black,
            ),
          ],

          const SizedBox(height: 24),
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

  bool _isPremierSelected() {
    if (_selectedVehicleId == null) return false;
    final cat = _availableCategories.firstWhere((c) => c['id'] == _selectedVehicleId, orElse: () => null);
    return cat != null && cat['model'] == 'Premier';
  }

  Widget _buildCategorySelector() {
    return Column(
      children: _availableCategories.map((cat) {
        final name = 'NetRide ${cat['model']}';
        final isSelected = _selectedVehicleId == cat['id'];
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(
            border: Border.all(color: isSelected ? Colors.black : Colors.grey[300]!, width: isSelected ? 2 : 1),
            borderRadius: BorderRadius.circular(12),
          ),
          child: ListTile(
            title: Text(name, style: GoogleFonts.poppins(fontWeight: isSelected ? FontWeight.bold : FontWeight.normal)),
            subtitle: Text(_getCategoryDescription(cat['model']), style: GoogleFonts.poppins(fontSize: 12)),
            trailing: isSelected ? const Icon(Icons.check_circle, color: Colors.black) : null,
            onTap: () => setState(() => _selectedVehicleId = cat['id']),
          ),
        );
      }).toList(),
    );
  }

  String _getCategoryDescription(String model) {
    switch (model) {
      case 'Economy': return 'Standard everyday rides (NetRide Economy)';
      case 'Extra': return 'Larger vehicles for more people (NetRide Extra)';
      case 'Lux': return 'Luxury sedans for a premium experience (NetRide Lux)';
      case 'SUV Lux': return 'High-end SUVs (NetRide SUV Lux)';
      case 'Premier': return 'Elite black-on-black service (NetRide Premier)';
      default: return '';
    }
  }

  Widget _buildCarPicker() {
    return GestureDetector(
      onTap: _showSearchableCarPicker,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey[400]!),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(
                (_selectedCarMake != null && _selectedCarModel != null)
                    ? '$_selectedCarMake $_selectedCarModel'
                    : 'Search for car make & model...',
                style: GoogleFonts.poppins(color: (_selectedCarMake != null) ? Colors.black : Colors.grey[600]),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const Icon(Icons.search, color: Colors.grey),
          ],
        ),
      ),
    );
  }

  void _showSearchableCarPicker() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (context) => _CarSearchDialog(
        onSelect: (car) {
          setState(() {
            _selectedCarMake = car.make;
            _selectedCarModel = car.model;
          });
        },
      ),
    );
  }

  Widget _buildColorPicker() {
    return DropdownButtonFormField<String>(
      value: _selectedColor,
      decoration: _inputDecoration('Select Exterior Color'),
      items: _colors.map((color) {
        return DropdownMenuItem<String>(
          value: color,
          child: Text(color),
        );
      }).toList(),
      onChanged: (val) => setState(() => _selectedColor = val),
    );
  }

  Widget _buildReviewStep() {
    final cat = _availableCategories.firstWhere((c) => c['id'] == _selectedVehicleId, orElse: () => {'model': 'N/A'});
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
          const Divider(height: 32),
          _ReviewItem(label: 'Category', value: 'NetRide ${cat['model']}'),
          _ReviewItem(label: 'Car', value: '$_selectedCarMake $_selectedCarModel'),
          _ReviewItem(label: 'Color', value: _selectedColor ?? 'N/A'),
          if (cat['model'] == 'Premier')
            _ReviewItem(label: 'Interior', value: 'Black (Confirmed)'),
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

class _CarSearchDialog extends StatefulWidget {
  final Function(CarModel) onSelect;
  const _CarSearchDialog({required this.onSelect});

  @override
  State<_CarSearchDialog> createState() => _CarSearchDialogState();
}

class _CarSearchDialogState extends State<_CarSearchDialog> {
  String _query = '';
  
  @override
  Widget build(BuildContext context) {
    final filteredCars = allCars.where((car) {
      final search = car.toString().toLowerCase();
      return search.contains(_query.toLowerCase());
    }).toList();

    return Container(
      height: MediaQuery.of(context).size.height * 0.8,
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          Container(
            width: 40,
            height: 4,
            decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2)),
          ),
          const SizedBox(height: 20),
          TextField(
            autofocus: true,
            decoration: InputDecoration(
              hintText: 'Search car make or model...',
              prefixIcon: const Icon(Icons.search),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onChanged: (val) => setState(() => _query = val),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: ListView.builder(
              itemCount: filteredCars.length,
              itemBuilder: (context, index) {
                final car = filteredCars[index];
                return ListTile(
                  title: Text(car.toString(), style: GoogleFonts.poppins()),
                  onTap: () {
                    widget.onSelect(car);
                    Navigator.pop(context);
                  },
                );
              },
            ),
          ),
        ],
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
