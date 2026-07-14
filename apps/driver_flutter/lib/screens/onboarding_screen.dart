import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import '../services/auth_service.dart';
import '../components/state_container.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final PageController _pageController = PageController();
  int _currentStep = 0;
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  bool _isSubmitting = false;

  static const _stepLabels = [
    'Take a Headshot',
    'Personal Info',
    'Phone Verification',
    'Identity Documents',
    'Vehicle Info',
    'Review & Submit',
  ];

  // Step 0: Headshot
  String? _profileImageUrl;

  // Step 1: Personal Info
  final _nameController = TextEditingController();
  final _dobController = TextEditingController();

  // Step 2: Phone Verification
  final _phoneController = TextEditingController();
  bool _isPhoneVerified = false;
  bool _isSendingCode = false;
  bool _codeSent = false;
  final _otpController = TextEditingController();

  // Step 3: Documents
  String? _licensePhotoFrontUrl;
  String? _licensePhotoBackUrl;
  String? _insurancePhotoUrl;
  String? _registrationPhotoUrl;

  // Step 4: Vehicle
  String? _selectedCarMake;
  String? _selectedCarModel;
  int? _selectedYear;
  String? _selectedColor;
  bool _isCustomVehicle = false;
  final _searchController = TextEditingController();
  final _plateNumberController = TextEditingController();
  String? _selectedPlateState;
  final _zipController = TextEditingController();

  List<String> _allMakes = [];
  List<String> _filteredMakes = [];
  List<String> _allModels = [];
  List<String> _filteredModels = [];
  List<int> _availableYears = [];
  bool _isLoadingVehicles = false;

  final List<String> _colors = [
    'Black', 'White', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Brown', 'Beige', 'Gold', 'Other'
  ];

  static const List<String> _usStates = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  ];

  @override
  void initState() {
    super.initState();
    _initData();
    _searchController.addListener(_onSearchChanged);
  }

  @override
  void dispose() {
    _searchController.removeListener(_onSearchChanged);
    _searchController.dispose();
    _nameController.dispose();
    _dobController.dispose();
    _phoneController.dispose();
    _otpController.dispose();
    _plateNumberController.dispose();
    _zipController.dispose();
    super.dispose();
  }

  void _onSearchChanged() {
    final query = _searchController.text.toLowerCase();
    setState(() {
      if (_selectedCarMake == null) {
        _filteredMakes = _allMakes
            .where((make) => make.toLowerCase().contains(query))
            .toList();
      } else if (_selectedCarModel == null) {
        _filteredModels = _allModels
            .where((model) => model.toLowerCase().contains(query))
            .toList();
      }
    });
  }

  Future<void> _initData() async {
    setState(() => _state = ViewState.loading);
    try {
      final results = await Future.wait([
        AuthService.getVehicleMakes(0),
        AuthService.getVehicleYears(),
        AuthService.getOnboardingProgress(),
      ]);

      final progress = results[2] as Map<String, dynamic>;
      final step = progress['onboarding_step'] as int? ?? 0;

      if (step >= 5 && !mounted) return;
      if (step >= 5) {
        Navigator.pushReplacementNamed(context, '/');
        return;
      }

      setState(() {
        _allMakes = (results[0] as List<dynamic>).cast<String>();
        _filteredMakes = _allMakes;
        _availableYears = (results[1] as List<dynamic>).cast<int>();
        _restoreProgress(progress);
        _state = ViewState.success;
      });
    } catch (e) {
      setState(() {
        _state = ViewState.failure;
        _errorMessage = 'We could not initialize the registration process. Please check your connection.';
      });
    }
  }

  void _restoreProgress(Map<String, dynamic> progress) {
    final step = progress['onboarding_step'] as int? ?? 0;
    _currentStep = step;
    if (progress['profile_image_url'] != null) {
      _profileImageUrl = progress['profile_image_url'];
    }
    if (progress['full_name'] != null) {
      _nameController.text = progress['full_name'];
    }
    if (progress['date_of_birth'] != null) {
      _dobController.text = progress['date_of_birth'];
    }
    if (progress['phone_number'] != null) {
      _phoneController.text = progress['phone_number'];
    }
    _isPhoneVerified = progress['phone_verified'] == true;

    if (step >= 3) {
      _loadDocuments();
    }
    if (step >= 4) {
      _loadVehicleInfo();
    }
  }

  Future<void> _loadDocuments() async {
    try {
      final profile = await AuthService.getDriverProfile();
      final driver = profile['driver'] ?? {};
      if (driver['license_photo_url'] != null) _licensePhotoFrontUrl = driver['license_photo_url'];
      if (driver['license_photo_back_url'] != null) _licensePhotoBackUrl = driver['license_photo_back_url'];
      if (driver['insurance_photo_url'] != null) _insurancePhotoUrl = driver['insurance_photo_url'];
      if (driver['registration_photo_url'] != null) _registrationPhotoUrl = driver['registration_photo_url'];
    } catch (_) {}
  }

  Future<void> _loadVehicleInfo() async {
    try {
      final profile = await AuthService.getDriverProfile();
      final vehicle = profile['vehicle'] ?? {};
      if (vehicle['license_plate_number'] != null) _plateNumberController.text = vehicle['license_plate_number'];
      if (vehicle['license_plate_state'] != null) _selectedPlateState = vehicle['license_plate_state'];
      if (vehicle['zip_code'] != null) _zipController.text = vehicle['zip_code'];
      if (vehicle['make'] != null) _selectedCarMake = vehicle['make'];
      if (vehicle['model'] != null) _selectedCarModel = vehicle['model'];
      if (vehicle['year'] != null) _selectedYear = vehicle['year'];
      if (vehicle['color'] != null) _selectedColor = vehicle['color'];
    } catch (_) {}
  }

  Future<void> _fetchModels(String make) async {
    setState(() => _isLoadingVehicles = true);
    try {
      final models = await AuthService.getVehicleModels(make, 0);
      setState(() {
        _allModels = List<String>.from(models);
        _filteredModels = _allModels;
        _isLoadingVehicles = false;
      });
    } catch (e) {
      setState(() => _isLoadingVehicles = false);
    }
  }

  Future<void> _nextStep() async {
    try {
      setState(() => _isSubmitting = true);

      final Map<String, dynamic> stepData = {};
      String? error;

      switch (_currentStep) {
        case 0:
          if (_profileImageUrl == null) {
            error = 'Please take a headshot photo before continuing.';
          } else {
            stepData['profile_image_url'] = _profileImageUrl;
          }
          break;
        case 1:
          if (_nameController.text.trim().isEmpty) {
            error = 'Full name is required.';
          } else if (_dobController.text.trim().isEmpty) {
            error = 'Date of birth is required.';
          } else {
            stepData['full_name'] = _nameController.text.trim();
            stepData['date_of_birth'] = _dobController.text.trim();
          }
          break;
        case 2:
          if (!_isPhoneVerified) {
            error = 'Please verify your phone number first.';
          }
          break;
        case 3:
          if (_licensePhotoFrontUrl == null) {
            error = 'Please upload the front of your driver license.';
          } else if (_licensePhotoBackUrl == null) {
            error = 'Please upload the back of your driver license.';
          } else if (_insurancePhotoUrl == null) {
            error = 'Please upload your insurance certificate.';
          } else if (_registrationPhotoUrl == null) {
            error = 'Please upload your vehicle registration.';
          } else {
            stepData['license_photo_url'] = _licensePhotoFrontUrl;
            stepData['license_photo_back_url'] = _licensePhotoBackUrl;
            stepData['insurance_photo_url'] = _insurancePhotoUrl;
            stepData['registration_photo_url'] = _registrationPhotoUrl;
          }
          break;
        case 4:
          if (_plateNumberController.text.trim().isEmpty) {
            error = 'License plate number is required.';
          } else if (_selectedPlateState == null) {
            error = 'Please select your license plate state.';
          } else if (_zipController.text.trim().isEmpty) {
            error = 'ZIP code is required.';
          } else {
            stepData['license_plate_number'] = _plateNumberController.text.trim();
            stepData['license_plate_state'] = _selectedPlateState;
            stepData['zip_code'] = _zipController.text.trim();
            stepData['make'] = _selectedCarMake;
            stepData['model'] = _selectedCarModel;
            stepData['year'] = _selectedYear;
            stepData['color'] = _selectedColor;
          }
          break;
      }

      if (error != null) {
        setState(() => _isSubmitting = false);
        _showError(error);
        return;
      }

      // Don't save step 2 data via onboarding step (handled by phone verification)
      if (_currentStep != 2) {
        await AuthService.saveOnboardingStep(_currentStep, stepData);
      }

      setState(() {
        _isSubmitting = false;
        _currentStep++;
      });

      if (_currentStep < 5) {
        _pageController.nextPage(
          duration: const Duration(milliseconds: 400),
          curve: Curves.easeInOut,
        );
      }
    } catch (e) {
      setState(() => _isSubmitting = false);
      _showError('Something went wrong: $e');
    }
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.redAccent),
    );
  }

  // --- Build Steps ---

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
                onPressed: () {
                  if (_currentStep == 4 && _selectedCarMake != null) {
                    setState(() {
                      if (_selectedCarModel != null) {
                        _selectedCarModel = null;
                        _searchController.clear();
                        _filteredModels = _allModels;
                      } else {
                        _selectedCarMake = null;
                        _searchController.clear();
                        _filteredMakes = _allMakes;
                      }
                    });
                  } else {
                    _pageController.previousPage(
                      duration: const Duration(milliseconds: 400),
                      curve: Curves.easeInOut,
                    );
                  }
                },
              )
            : null,
        title: _StepIndicator(currentStep: _currentStep, totalSteps: 6),
      ),
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _initData,
        successWidget: PageView(
          controller: _pageController,
          physics: const NeverScrollableScrollPhysics(),
          onPageChanged: (idx) => setState(() => _currentStep = idx),
          children: [
            _buildHeadshotStep(),
            _buildPersonalInfoStep(),
            _buildPhoneVerificationStep(),
            _buildDocumentsStep(),
            _buildVehicleStep(),
            _buildReviewStep(),
          ],
        ),
      ),
      bottomNavigationBar: _state == ViewState.success
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(24.0),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _stepLabels[_currentStep],
                      style: GoogleFonts.poppins(
                        fontSize: 13,
                        color: Colors.grey[600],
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      height: 56,
                      child: ElevatedButton(
                        onPressed: _isSubmitting
                            ? null
                            : (_currentStep == 5 ? _submit : _nextStep),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.black,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        child: _isSubmitting
                            ? const CircularProgressIndicator(color: Colors.white)
                            : Text(
                                _currentStep == 5
                                    ? 'Submit Application'
                                    : 'Continue',
                              ),
                      ),
                    ),
                  ],
                ),
              ),
            )
          : null,
    );
  }

  Widget _buildHeadshotStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Take a Headshot',
            style: GoogleFonts.poppins(
              fontSize: 24,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'This photo will be used for your profile and verification.',
            style: GoogleFonts.poppins(fontSize: 14, color: Colors.grey[600]),
          ),
          const SizedBox(height: 40),
          Center(
            child: GestureDetector(
              onTap: () => _pickImage((url) => _profileImageUrl = url),
              child: CircleAvatar(
                radius: 80,
                backgroundColor: Colors.grey[100],
                backgroundImage: _profileImageUrl != null
                    ? NetworkImage(_profileImageUrl!)
                    : null,
                child: _profileImageUrl == null
                    ? Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(Icons.add_a_photo_outlined,
                              size: 36, color: Colors.grey),
                          const SizedBox(height: 8),
                          Text(
                            'Tap to upload',
                            style: GoogleFonts.poppins(
                              fontSize: 13,
                              color: Colors.grey,
                            ),
                          ),
                        ],
                      )
                    : null,
              ),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _buildPersonalInfoStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Personal Info',
            style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Text(
            'Tell us about yourself.',
            style: GoogleFonts.poppins(fontSize: 14, color: Colors.grey[600]),
          ),
          const SizedBox(height: 32),
          _buildTextField(
            label: 'Full Name',
            controller: _nameController,
            hint: 'John Doe',
          ),
          const SizedBox(height: 16),
          GestureDetector(
            onTap: _pickDate,
            child: AbsorbPointer(
              child: _buildTextField(
                label: 'Date of Birth',
                controller: _dobController,
                hint: 'YYYY-MM-DD',
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPhoneVerificationStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Phone Verification',
            style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Text(
            'We need to verify your phone number to continue.',
            style: GoogleFonts.poppins(fontSize: 14, color: Colors.grey[600]),
          ),
          const SizedBox(height: 32),
          if (!_isPhoneVerified) ...[
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _phoneController,
                    enabled: !_codeSent,
                    decoration: _inputDecoration('Phone Number').copyWith(
                      hintText: '+1 (555) 123-4567',
                    ),
                    keyboardType: TextInputType.phone,
                  ),
                ),
                const SizedBox(width: 8),
                if (!_codeSent)
                  ElevatedButton(
                    onPressed: _isSendingCode ? null : _sendPhoneCode,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.black,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: _isSendingCode
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              color: Colors.white,
                              strokeWidth: 2,
                            ),
                          )
                        : const Text('Send Code'),
                  ),
              ],
            ),
            if (_codeSent) ...[
              const SizedBox(height: 24),
              TextField(
                controller: _otpController,
                decoration: _inputDecoration('Verification Code').copyWith(
                  hintText: '6-digit code',
                ),
                keyboardType: TextInputType.number,
                maxLength: 6,
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: ElevatedButton(
                  onPressed: _verifyPhoneCode,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.black,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: const Text('Verify Phone'),
                ),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: () {
                  setState(() {
                    _codeSent = false;
                    _otpController.clear();
                  });
                },
                child: const Text(
                  'Change phone number',
                  style: TextStyle(color: Colors.grey),
                ),
              ),
            ],
          ],
          if (_isPhoneVerified) ...[
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.green[50],
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Colors.green[200]!),
              ),
              child: Row(
                children: [
                  Icon(Icons.check_circle, color: Colors.green[700], size: 28),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Phone Verified',
                          style: GoogleFonts.poppins(
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                          ),
                        ),
                        Text(
                          _phoneController.text,
                          style: GoogleFonts.poppins(
                            fontSize: 14,
                            color: Colors.grey[600],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  String _normalizePhone(String raw) {
    final digits = raw.replaceAll(RegExp(r'\D'), '');
    if (digits.startsWith('1')) return '+$digits';
    return '+1$digits';
  }

  Future<void> _sendPhoneCode() async {
    final raw = _phoneController.text.trim();
    if (raw.isEmpty) {
      _showError('Please enter your phone number.');
      return;
    }
    final normalized = _normalizePhone(raw);
    _phoneController.text = normalized;
    setState(() => _isSendingCode = true);
    try {
      final result = await AuthService.requestPhoneOTP(normalized);
      if (result['auto_verified'] == true) {
        setState(() {
          _isPhoneVerified = true;
          _isSendingCode = false;
        });
        _showSuccess('Phone number already verified on your account.');
      } else {
        setState(() {
          _codeSent = true;
          _isSendingCode = false;
        });
        _showSuccess('Verification code sent to $normalized');
      }
    } catch (e) {
      setState(() => _isSendingCode = false);
      final msg = e.toString();
      if (msg.contains('already') || msg.contains('associated')) {
        _showError('This phone number already exists.');
      } else {
        _showError('Failed to send code.');
      }
    }
  }

  Future<void> _verifyPhoneCode() async {
    if (_otpController.text.trim().length != 6) {
      _showError('Please enter the 6-digit verification code.');
      return;
    }
    setState(() => _isSendingCode = true);
    try {
      await AuthService.verifyPhoneOTP(
        phoneNumber: _phoneController.text.trim(),
        code: _otpController.text.trim(),
      );
      setState(() {
        _isPhoneVerified = true;
        _isSendingCode = false;
      });
      _showSuccess('Phone number verified successfully!');
    } catch (e) {
      setState(() => _isSendingCode = false);
      _showError('Invalid code. Please try again.');
    }
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(now.year - 25),
      firstDate: DateTime(now.year - 100),
      lastDate: DateTime(now.year - 21),
      helpText: 'Select your date of birth',
    );
    if (picked != null) {
      _dobController.text =
          '${picked.year}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
    }
  }

  void _showSuccess(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.green),
    );
  }

  Widget _buildDocumentsStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Identity Documents',
            style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          Text(
            'Upload clear photos of your documents.',
            style: GoogleFonts.poppins(fontSize: 14, color: Colors.grey[600]),
          ),
          const SizedBox(height: 32),
          Row(
            children: [
              Expanded(
                child: _buildImagePickerBox(
                  label: 'License\nFront',
                  imageUrl: _licensePhotoFrontUrl,
                  onTap: () => _pickImage((url) => _licensePhotoFrontUrl = url),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: _buildImagePickerBox(
                  label: 'License\nBack',
                  imageUrl: _licensePhotoBackUrl,
                  onTap: () => _pickImage((url) => _licensePhotoBackUrl = url),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _buildImagePickerBox(
            label: 'Insurance Certificate',
            imageUrl: _insurancePhotoUrl,
            onTap: () => _pickImage((url) => _insurancePhotoUrl = url),
          ),
          const SizedBox(height: 16),
          _buildImagePickerBox(
            label: 'Vehicle Registration',
            imageUrl: _registrationPhotoUrl,
            onTap: () => _pickImage((url) => _registrationPhotoUrl = url),
          ),
          const SizedBox(height: 12),
          Text(
            'We also verify your documents with our compliance team.',
            style: GoogleFonts.poppins(fontSize: 12, color: Colors.grey),
          ),
        ],
      ),
    );
  }

  Widget _buildVehicleStep() {
    if (_selectedCarMake == null) {
      return _buildMakeSelection();
    }
    if (_selectedCarModel == null && !_isCustomVehicle) {
      return _buildModelSelection();
    }
    return _buildVehicleDetails();
  }

  Widget _buildMakeSelection() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Your Vehicle',
                style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              Text(
                'Select your vehicle manufacturer.',
                style: GoogleFonts.poppins(fontSize: 14, color: Colors.grey[600]),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _searchController,
                decoration: _inputDecoration('Search Manufacturer').copyWith(
                  prefixIcon:
                      const Icon(Icons.search, color: Colors.black),
                  suffixIcon: _searchController.text.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear),
                          onPressed: () => _searchController.clear())
                      : null,
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: _filteredMakes.length,
            itemBuilder: (context, index) {
              final make = _filteredMakes[index];
              return ListTile(
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 24, vertical: 4),
                title: Text(make,
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                trailing: const Icon(Icons.chevron_right, size: 18),
                onTap: () {
                  setState(() {
                    _selectedCarMake = make;
                    _searchController.clear();
                  });
                  _fetchModels(make);
                },
              );
            },
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24.0, 8.0, 24.0, 8.0),
            child: SizedBox(
              width: double.infinity,
              child: TextButton.icon(
                onPressed: () => _enterCustomVehicle(),
                icon: const Icon(Icons.add_circle_outline, color: Colors.black),
                label: Text(
                  "Didn't find your car?",
                  style: GoogleFonts.poppins(
                    color: Colors.black,
                    fontWeight: FontWeight.w600,
                    fontSize: 15,
                  ),
                ),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: BorderSide(color: Colors.grey[300]!),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildModelSelection() {
    if (_isLoadingVehicles) {
      return const Center(child: CircularProgressIndicator(color: Colors.black));
    }

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _selectedCarMake!,
                style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _searchController,
                decoration: _inputDecoration('Search Model').copyWith(
                  prefixIcon:
                      const Icon(Icons.search, color: Colors.black),
                  suffixIcon: _searchController.text.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear),
                          onPressed: () => _searchController.clear())
                      : null,
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: _filteredModels.length,
            itemBuilder: (context, index) {
              final model = _filteredModels[index];
              return ListTile(
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 24, vertical: 4),
                title: Text(model,
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                onTap: () => setState(() {
                  _selectedCarModel = model;
                  _searchController.clear();
                }),
              );
            },
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24.0, 8.0, 24.0, 8.0),
            child: SizedBox(
              width: double.infinity,
              child: TextButton.icon(
                onPressed: () => _enterCustomVehicle(),
                icon: const Icon(Icons.add_circle_outline, color: Colors.black),
                label: Text(
                  "Didn't find your car?",
                  style: GoogleFonts.poppins(
                    color: Colors.black,
                    fontWeight: FontWeight.w600,
                    fontSize: 15,
                  ),
                ),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: BorderSide(color: Colors.grey[300]!),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildVehicleDetails() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${_selectedCarMake} ${_selectedCarModel ?? "Custom"}',
                  style: GoogleFonts.poppins(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              TextButton(
                onPressed: () => setState(() {
                  _selectedCarMake = null;
                  _selectedCarModel = null;
                  _isCustomVehicle = false;
                }),
                child: const Text('Change'),
              ),
            ],
          ),
          const SizedBox(height: 24),
          DropdownButtonFormField<int>(
            value: _selectedYear,
            decoration: _inputDecoration('Year'),
            items: _availableYears
                .map((y) => DropdownMenuItem(value: y, child: Text(y.toString())))
                .toList(),
            onChanged: (val) => setState(() => _selectedYear = val),
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            value: _selectedColor,
            decoration: _inputDecoration('Exterior Color'),
            items: _colors
                .map((c) => DropdownMenuItem(value: c, child: Text(c)))
                .toList(),
            onChanged: (val) => setState(() => _selectedColor = val),
          ),
          const SizedBox(height: 24),
          const Divider(),
          const SizedBox(height: 16),
          Text(
            'License Plate & Location',
            style: GoogleFonts.poppins(
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 16),
          _buildTextField(
            label: 'License Plate Number',
            controller: _plateNumberController,
            hint: 'ABC 1234',
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            value: _selectedPlateState,
            decoration: _inputDecoration('Plate State'),
            items: _usStates
                .map((s) => DropdownMenuItem(value: s, child: Text(s)))
                .toList(),
            onChanged: (val) => setState(() => _selectedPlateState = val),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: _buildTextField(
                  label: 'ZIP Code',
                  controller: _zipController,
                  hint: '12345',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _enterCustomVehicle() {
    final makeController = TextEditingController();
    final modelController = TextEditingController();
    int? pickedYear;
    String? pickedColor;

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final canConfirm = makeController.text.trim().isNotEmpty &&
                modelController.text.trim().isNotEmpty &&
                pickedYear != null &&
                pickedColor != null;

            return AlertDialog(
              title: const Text('Enter Your Car Details'),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Brand',
                        style: GoogleFonts.poppins(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    TextField(
                        controller: makeController,
                        decoration: _inputDecoration('e.g. Lucid')),
                    const SizedBox(height: 14),
                    Text('Model',
                        style: GoogleFonts.poppins(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    TextField(
                        controller: modelController,
                        decoration: _inputDecoration('e.g. Air')),
                    const SizedBox(height: 14),
                    Text('Year',
                        style: GoogleFonts.poppins(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<int>(
                      value: pickedYear,
                      decoration: _inputDecoration('Select year'),
                      items: _availableYears
                          .map((y) =>
                              DropdownMenuItem(value: y, child: Text(y.toString())))
                          .toList(),
                      onChanged: (val) => setDialogState(() => pickedYear = val),
                    ),
                    const SizedBox(height: 14),
                    Text('Color',
                        style: GoogleFonts.poppins(
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      value: pickedColor,
                      decoration: _inputDecoration('Select color'),
                      items: _colors
                          .map((c) => DropdownMenuItem(value: c, child: Text(c)))
                          .toList(),
                      onChanged: (val) => setDialogState(() => pickedColor = val),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogContext),
                  child: const Text('CANCEL'),
                ),
                ElevatedButton(
                  onPressed: canConfirm
                      ? () {
                          setState(() {
                            _selectedCarMake = makeController.text.trim();
                            _selectedCarModel = modelController.text.trim();
                            _selectedYear = pickedYear;
                            _selectedColor = pickedColor;
                            _isCustomVehicle = true;
                          });
                          Navigator.pop(dialogContext);
                        }
                      : null,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.black,
                    foregroundColor: Colors.white,
                  ),
                  child: const Text('CONFIRM'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Widget _buildReviewStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Review Application',
            style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 24),
          if (_profileImageUrl != null) ...[
            Center(
              child: CircleAvatar(
                radius: 40,
                backgroundImage: NetworkImage(_profileImageUrl!),
              ),
            ),
            const SizedBox(height: 16),
          ],
          _sectionHeader('Profile'),
          const SizedBox(height: 8),
          _ReviewItem(label: 'Name', value: _nameController.text),
          _ReviewItem(label: 'DOB', value: _dobController.text),
          _ReviewItem(label: 'Phone', value: _phoneController.text),
          const Divider(height: 32),
          _sectionHeader('Identity Documents'),
          const SizedBox(height: 8),
          _ReviewItem(
            label: 'License (Front)',
            value: _licensePhotoFrontUrl != null ? 'Uploaded' : 'Missing',
          ),
          _ReviewItem(
            label: 'License (Back)',
            value: _licensePhotoBackUrl != null ? 'Uploaded' : 'Missing',
          ),
          _ReviewItem(
            label: 'Insurance',
            value: _insurancePhotoUrl != null ? 'Uploaded' : 'Missing',
          ),
          _ReviewItem(
            label: 'Registration',
            value: _registrationPhotoUrl != null ? 'Uploaded' : 'Missing',
          ),
          const Divider(height: 32),
          _sectionHeader('Vehicle'),
          const SizedBox(height: 8),
          _ReviewItem(
            label: 'Vehicle',
            value: '${_selectedYear} ${_selectedCarMake} ${_selectedCarModel}',
          ),
          _ReviewItem(label: 'Color', value: _selectedColor ?? 'N/A'),
          _ReviewItem(label: 'Plate', value: _plateNumberController.text),
          _ReviewItem(label: 'State', value: _selectedPlateState ?? 'N/A'),
          _ReviewItem(label: 'ZIP', value: _zipController.text),
          const Divider(height: 32),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.amber[50],
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.amber[200]!),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.info_outline, color: Colors.amber[800], size: 20),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'After submission, your application will be reviewed. '
                    'Your background check status will be updated within 24 hours.',
                    style: GoogleFonts.poppins(
                      fontSize: 13,
                      color: Colors.amber[900],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionHeader(String text) {
    return Text(
      text,
      style: GoogleFonts.poppins(
        fontSize: 14,
        fontWeight: FontWeight.w600,
        color: Colors.grey[700],
      ),
    );
  }

  Widget _buildTextField({
    required String label,
    required TextEditingController controller,
    String? hint,
  }) {
    return TextField(
      controller: controller,
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

  Widget _buildImagePickerBox({
    required String label,
    String? imageUrl,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: double.infinity,
        height: 100,
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey[300]!),
          borderRadius: BorderRadius.circular(12),
          image: imageUrl != null
              ? DecorationImage(
                  image: NetworkImage(imageUrl), fit: BoxFit.cover)
              : null,
        ),
        child: imageUrl == null
            ? Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.cloud_upload_outlined, color: Colors.grey),
                  Text(label,
                      style: const TextStyle(color: Colors.grey, fontSize: 12)),
                ],
              )
            : null,
      ),
    );
  }

  Future<void> _pickImage(Function(String) onUpload) async {
    final picker = ImagePicker();
    final pickedFile =
        await picker.pickImage(source: ImageSource.gallery, imageQuality: 70);
    if (pickedFile != null) {
      try {
        final url = await AuthService.uploadImage(File(pickedFile.path));
        onUpload(url);
        setState(() {});
      } catch (e) {
        _showError('Upload failed: $e');
      }
    }
  }

  Future<void> _submit() async {
    if (_isSubmitting) return;
    setState(() => _isSubmitting = true);

    if (!mounted) return;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(child: CircularProgressIndicator()),
    );

    try {
      await AuthService.completeOnboarding();
      if (mounted) {
        Navigator.of(context).pop();
        Navigator.pushNamedAndRemoveUntil(context, '/', (route) => false);
      }
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      final errMsg = e.toString();
      if (errMsg.contains('already') || errMsg.contains('Duplicate')) {
        _showError('Application already submitted. You can check status on the home screen.');
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/', (route) => false);
        }
      } else {
        _showError('Connection error. Please try again.');
      }
      if (mounted) setState(() => _isSubmitting = false);
    }
  }
}

class _StepIndicator extends StatelessWidget {
  final int currentStep;
  final int totalSteps;
  const _StepIndicator({required this.currentStep, required this.totalSteps});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(
        totalSteps,
        (index) => Container(
          width: 20,
          height: 4,
          margin: const EdgeInsets.symmetric(horizontal: 4),
          decoration: BoxDecoration(
            color: index <= currentStep ? Colors.black : Colors.grey[200],
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
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
