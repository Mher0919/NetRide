import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
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

  // Form Data
  final _nameController = TextEditingController();
  final _phoneController = TextEditingController();
  final _dobController = TextEditingController();
  String? _profileImageUrl;
  bool _isPhoneVerified = false;
  bool _isSendingCode = false;
  bool _codeSent = false;
  final List<TextEditingController> _codeControllers = List.generate(6, (_) => TextEditingController());
  final List<FocusNode> _codeFocusNodes = List.generate(6, (_) => FocusNode());

  final _licenseNumberController = TextEditingController();
  final _licenseExpiryController = TextEditingController();
  String? _licensePhotoFrontUrl;
  String? _licensePhotoBackUrl;
  String? _insurancePhotoUrl;
  String? _registrationPhotoUrl;

  // NEW Vehicle Discovery Data
  String? _selectedVehicleId; // Internal Class Category (CORE/ELITE/PRESTIGE)
  String? _selectedCarMake;
  String? _selectedCarModel;
  int? _selectedYear;
  String? _selectedColor;
  bool _hasBlackInterior = false;
  bool _isCustomVehicle = false;
  
  final _searchController = TextEditingController();
  final _plateNumberController = TextEditingController();
  String? _platePhotoUrl;
  String? _inspectionPhotoUrl;
  final List<String> _carPhotoUrls = [];

  List<dynamic> _availableCategories = [];
  List<int> _availableYears = [];
  List<String> _allMakes = [];
  List<String> _filteredMakes = [];
  List<String> _allModels = [];
  List<String> _filteredModels = [];
  
  bool _isLoadingVehicles = false;

  final List<String> _colors = [
    'Black', 'White', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Brown', 'Beige', 'Gold', 'Other'
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
        AuthService.getVehicles(), // Class categories
        AuthService.getVehicleMakes(0), // Master list (year 0 proxy for all)
        AuthService.getVehicleYears(),
      ]);
      
      setState(() {
        _availableCategories = results[0];
        _allMakes = List<String>.from(results[1]);
        _filteredMakes = _allMakes;
        _availableYears = List<int>.from(results[2]);
        _state = ViewState.success;
      });
    } catch (e) {
      setState(() {
        _state = ViewState.failure;
        _errorMessage = 'We could not initialize the registration process. Please check your connection.';
      });
    }
  }

  Future<void> _fetchModels(String make) async {
    setState(() => _isLoadingVehicles = true);
    try {
      final models = await AuthService.getVehicleModels(make, 0); // proxy
      setState(() {
        _allModels = List<String>.from(models);
        _filteredModels = _allModels;
        _isLoadingVehicles = false;
      });
    } catch (e) {
      setState(() => _isLoadingVehicles = false);
    }
  }

  // --- UI Helpers ---

  void _nextStep() {
    if (_currentStep == 0) {
      if (_profileImageUrl == null || _dobController.text.isEmpty || _nameController.text.isEmpty || _phoneController.text.isEmpty || !_isPhoneVerified) {
        _showError('Please complete all profile information.'); return;
      }
    } else if (_currentStep == 1) {
      if (_licensePhotoFrontUrl == null || _licensePhotoBackUrl == null || _insurancePhotoUrl == null || _registrationPhotoUrl == null || _licenseNumberController.text.isEmpty) {
        _showError('Please upload all required documents.'); return;
      }
    } else if (_currentStep == 2) {
      final hasVehicleId = _selectedVehicleId != null;
      final hasVehicleInfo = _selectedCarMake != null && _selectedCarModel != null && _selectedYear != null && _selectedColor != null;
      if (!hasVehicleInfo || _plateNumberController.text.isEmpty || _platePhotoUrl == null || _inspectionPhotoUrl == null) {
        _showError('Please complete your vehicle details and upload all photos.'); return;
      }
      if (!hasVehicleId && !_isCustomVehicle) {
        _showError('Please pick a ride category or use the custom vehicle option.'); return;
      }
    }

    if (_currentStep < 3) {
      _pageController.nextPage(duration: const Duration(milliseconds: 400), curve: Curves.easeInOut);
    }
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: Colors.redAccent));
  }

  // --- Build Steps ---

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFEEEBE6),
      appBar: AppBar(
        backgroundColor: const Color(0xFFEEEBE6),
        elevation: 0,
        leading: _currentStep > 0 ? IconButton(icon: const Icon(Icons.arrow_back, color: Colors.black), onPressed: () {
          if (_currentStep == 2 && _selectedCarMake != null) {
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
            _pageController.previousPage(duration: const Duration(milliseconds: 400), curve: Curves.easeInOut);
          }
        }) : null,
        title: _StepIndicator(currentStep: _currentStep),
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
            _buildPersonalInfoStep(),
            _buildIdentityStep(),
            _buildVehicleStep(),
            _buildReviewStep(),
          ],
        ),
      ),
      bottomNavigationBar: _state == ViewState.success ? SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: SizedBox(
            height: 56,
            child: ElevatedButton(
              onPressed: _isSubmitting ? null : (_currentStep == 3 ? _submit : _nextStep),
              style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
              child: _isSubmitting ? const CircularProgressIndicator(color: Colors.white) : Text(_currentStep == 3 ? 'Submit Application' : 'Next Step'),
            ),
          ),
        ),
      ) : null,
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
                radius: 60,
                backgroundColor: Colors.grey[100],
                backgroundImage: _profileImageUrl != null ? NetworkImage(_profileImageUrl!) : null,
                child: _profileImageUrl == null ? const Icon(Icons.add_a_photo_outlined, size: 32, color: Colors.grey) : null,
              ),
            ),
          ),
          const SizedBox(height: 32),
          _buildTextField(label: 'Full Name', controller: _nameController),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(child: TextField(controller: _phoneController, enabled: !_isPhoneVerified, decoration: _inputDecoration('Phone Number'))),
              const SizedBox(width: 8),
              if (!_isPhoneVerified) ElevatedButton(onPressed: _isPhoneVerified ? null : () => setState(() => _isPhoneVerified = true), child: const Text('Verify')),
            ],
          ),
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
          const SizedBox(height: 24),
          _buildTextField(label: 'Driver License Number', controller: _licenseNumberController),
          const SizedBox(height: 16),
          _buildTextField(label: 'License Expiry', controller: _licenseExpiryController, hint: 'YYYY-MM-DD'),
          const SizedBox(height: 24),
          Row(
            children: [
              Expanded(child: _buildImagePickerBox(label: 'License Front', imageUrl: _licensePhotoFrontUrl, onTap: () => _pickImage((url) => _licensePhotoFrontUrl = url))),
              const SizedBox(width: 16),
              Expanded(child: _buildImagePickerBox(label: 'License Back', imageUrl: _licensePhotoBackUrl, onTap: () => _pickImage((url) => _licensePhotoBackUrl = url))),
            ],
          ),
          const SizedBox(height: 16),
          _buildImagePickerBox(label: 'Insurance Certificate', imageUrl: _insurancePhotoUrl, onTap: () => _pickImage((url) => _insurancePhotoUrl = url)),
          const SizedBox(height: 16),
          _buildImagePickerBox(label: 'Car Registration', imageUrl: _registrationPhotoUrl, onTap: () => _pickImage((url) => _registrationPhotoUrl = url)),
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
              Text('Your Vehicle', style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
              const SizedBox(height: 16),
              TextField(
                controller: _searchController,
                decoration: _inputDecoration('Search Manufacturer (e.g. Mercedes)').copyWith(
                  prefixIcon: const Icon(Icons.search, color: Colors.black),
                  suffixIcon: _searchController.text.isNotEmpty ? IconButton(icon: const Icon(Icons.clear), onPressed: () => _searchController.clear()) : null,
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
                contentPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 4),
                title: Text(make, style: const TextStyle(fontWeight: FontWeight.w600)),
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
    if (_isLoadingVehicles) return const Center(child: CircularProgressIndicator(color: Colors.black));

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_selectedCarMake!, style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
              const SizedBox(height: 16),
              TextField(
                controller: _searchController,
                decoration: _inputDecoration('Search Model (e.g. EQE)').copyWith(
                  prefixIcon: const Icon(Icons.search, color: Colors.black),
                  suffixIcon: _searchController.text.isNotEmpty ? IconButton(icon: const Icon(Icons.clear), onPressed: () => _searchController.clear()) : null,
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
                contentPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 4),
                title: Text(model, style: const TextStyle(fontWeight: FontWeight.w600)),
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
              Expanded(child: Text('${_selectedCarMake} ${_selectedCarModel ?? "Custom"}', style: GoogleFonts.poppins(fontSize: 20, fontWeight: FontWeight.bold))),
              TextButton(onPressed: () => setState(() { _selectedCarMake = null; _selectedCarModel = null; _isCustomVehicle = false; _platePhotoUrl = null; }), child: const Text('Change')),
            ],
          ),
          const SizedBox(height: 24),
          DropdownButtonFormField<int>(
            value: _selectedYear,
            decoration: _inputDecoration('Year'),
            items: _availableYears.map((y) => DropdownMenuItem(value: y, child: Text(y.toString()))).toList(),
            onChanged: (val) => setState(() => _selectedYear = val),
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            value: _selectedColor,
            decoration: _inputDecoration('Exterior Color'),
            items: _colors.map((c) => DropdownMenuItem(value: c, child: Text(c))).toList(),
            onChanged: (val) => setState(() => _selectedColor = val),
          ),
          const SizedBox(height: 24),
          Text('Ride Category', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const SizedBox(height: 8),
          ..._availableCategories.map((cat) {
            final isSelected = _selectedVehicleId == cat['id'];
            return Container(
              margin: const EdgeInsets.only(bottom: 8),
              decoration: BoxDecoration(
                border: Border.all(color: isSelected ? Colors.black : Colors.grey[300]!, width: isSelected ? 2 : 1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: ListTile(
                title: Text('NetRide ${cat['model']}', style: TextStyle(fontWeight: isSelected ? FontWeight.bold : FontWeight.normal)),
                trailing: isSelected ? const Icon(Icons.check_circle, color: Colors.black) : null,
                onTap: () => setState(() => _selectedVehicleId = cat['id']),
              ),
            );
          }),
          const SizedBox(height: 24),
          _buildTextField(label: 'License Plate Number', controller: _plateNumberController),
          const SizedBox(height: 16),
          _buildImagePickerBox(label: 'License Plate Photo', imageUrl: _platePhotoUrl, onTap: () => _pickImage((url) => _platePhotoUrl = url)),
          const SizedBox(height: 16),
          _buildImagePickerBox(label: 'Inspection Certificate', imageUrl: _inspectionPhotoUrl, onTap: () => _pickImage((url) => _inspectionPhotoUrl = url)),
          const SizedBox(height: 16),
          Text('Car Photos (min 2)', style: const TextStyle(fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8, runSpacing: 8,
            children: [
              ..._carPhotoUrls.map((url) => Container(width: 80, height: 80, decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), image: DecorationImage(image: NetworkImage(url), fit: BoxFit.cover)))),
              if (_carPhotoUrls.length < 4) GestureDetector(onTap: () => _pickImage((url) => _carPhotoUrls.add(url)), child: Container(width: 80, height: 80, decoration: BoxDecoration(color: Colors.grey[100], borderRadius: BorderRadius.circular(8)), child: const Icon(Icons.add))),
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
        void onAnyChange() => (dialogContext as Element).markNeedsBuild();
        makeController.addListener(onAnyChange);
        modelController.addListener(onAnyChange);

        void closeDialog() {
          makeController.removeListener(onAnyChange);
          modelController.removeListener(onAnyChange);
          makeController.dispose();
          modelController.dispose();
          Navigator.pop(dialogContext);
        }

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
                    Text('Brand', style: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    TextField(controller: makeController, decoration: _inputDecoration('e.g. Lucid')),
                    const SizedBox(height: 14),
                    Text('Model', style: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    TextField(controller: modelController, decoration: _inputDecoration('e.g. Air')),
                    const SizedBox(height: 14),
                    Text('Year', style: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<int>(
                      value: pickedYear,
                      decoration: _inputDecoration('Select year'),
                      items: _availableYears.map((y) => DropdownMenuItem(value: y, child: Text(y.toString()))).toList(),
                      onChanged: (val) => setDialogState(() => pickedYear = val),
                    ),
                    const SizedBox(height: 14),
                    Text('Color', style: GoogleFonts.poppins(fontSize: 13, fontWeight: FontWeight.w500, color: Colors.grey[700])),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      value: pickedColor,
                      decoration: _inputDecoration('Select color'),
                      items: _colors.map((c) => DropdownMenuItem(value: c, child: Text(c))).toList(),
                      onChanged: (val) => setDialogState(() => pickedColor = val),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: closeDialog,
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
                          closeDialog();
                        }
                      : null,
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
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
          Text('Review Application', style: GoogleFonts.poppins(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 24),
          _ReviewItem(label: 'Vehicle', value: '${_selectedYear} ${_selectedCarMake} ${_selectedCarModel}'),
          _ReviewItem(label: 'Color', value: _selectedColor ?? 'N/A'),
          _ReviewItem(label: 'Plate', value: _plateNumberController.text),
          const Divider(height: 32),
          const Text('Your application will be reviewed by our compliance team within 24 hours.', style: TextStyle(fontSize: 12, color: Colors.grey)),
        ],
      ),
    );
  }

  Widget _buildTextField({required String label, required TextEditingController controller, String? hint}) {
    return TextField(controller: controller, decoration: _inputDecoration(label).copyWith(hintText: hint));
  }

  InputDecoration _inputDecoration(String label) {
    return InputDecoration(
      labelText: label, border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Colors.black, width: 2)),
    );
  }

  Widget _buildImagePickerBox({required String label, String? imageUrl, required VoidCallback onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: double.infinity, height: 100,
        decoration: BoxDecoration(border: Border.all(color: Colors.grey[300]!), borderRadius: BorderRadius.circular(12), image: imageUrl != null ? DecorationImage(image: NetworkImage(imageUrl), fit: BoxFit.cover) : null),
        child: imageUrl == null ? Column(mainAxisAlignment: MainAxisAlignment.center, children: [const Icon(Icons.cloud_upload_outlined, color: Colors.grey), Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12))]) : null,
      ),
    );
  }

  Future<void> _pickImage(Function(String) onUpload) async {
    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(source: ImageSource.gallery, imageQuality: 70);
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
    setState(() => _isSubmitting = true);
    try {
      final data = {
        'personalInfo': { 'full_name': _nameController.text, 'phone_number': _phoneController.text, 'date_of_birth': _dobController.text, 'profile_image_url': _profileImageUrl },
        'identity': { 'license_number': _licenseNumberController.text, 'license_expiry_date': _licenseExpiryController.text, 'license_photo_url': _licensePhotoFrontUrl, 'license_photo_back_url': _licensePhotoBackUrl, 'insurance_photo_url': _insurancePhotoUrl, 'registration_photo_url': _registrationPhotoUrl },
        'vehicle': { 'vehicle_id': _selectedVehicleId, 'make': _selectedCarMake, 'model': _selectedCarModel, 'year': _selectedYear, 'color': _selectedColor, 'license_plate_number': _plateNumberController.text, 'license_plate_photo_url': _platePhotoUrl, 'inspection_photo_url': _inspectionPhotoUrl, 'car_photo_urls': _carPhotoUrls },
      };
      await AuthService.onboardDriver(data);
      if (mounted) Navigator.pushReplacementNamed(context, '/success');
    } catch (e) {
      _showError('Onboarding failed: $e');
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }
}

class _StepIndicator extends StatelessWidget {
  final int currentStep;
  const _StepIndicator({required this.currentStep});

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisAlignment: MainAxisAlignment.center, children: List.generate(4, (index) => Container(width: 20, height: 4, margin: const EdgeInsets.symmetric(horizontal: 4), decoration: BoxDecoration(color: index <= currentStep ? Colors.black : Colors.grey[200], borderRadius: BorderRadius.circular(2)))));
  }
}

class _ReviewItem extends StatelessWidget {
  final String label, value;
  const _ReviewItem({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(padding: const EdgeInsets.only(bottom: 12.0), child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(label, style: const TextStyle(color: Colors.grey)), Text(value, style: const TextStyle(fontWeight: FontWeight.bold))]));
  }
}
