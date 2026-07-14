import 'dart:io';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:image_picker/image_picker.dart';
import '../services/user_service.dart';
import '../services/auth_service.dart';

const _usStates = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

class ReplaceVehicleScreen extends StatefulWidget {
  const ReplaceVehicleScreen({super.key});

  @override
  State<ReplaceVehicleScreen> createState() => _ReplaceVehicleScreenState();
}

class _ReplaceVehicleScreenState extends State<ReplaceVehicleScreen> {
  final _formKey = GlobalKey<FormState>();
  final _colorController = TextEditingController();
  final _interiorColorController = TextEditingController();
  final _plateController = TextEditingController();
  final _zipController = TextEditingController();

  // Dropdown selections
  String? _selectedYear;
  String? _selectedMake;
  String? _selectedModel;
  String? _selectedState;

  List<int> _years = [];
  List<String> _makes = [];
  List<String> _models = [];
  bool _loadingYears = true;
  bool _loadingMakes = false;
  bool _loadingModels = false;

  File? _registrationImage;
  File? _insuranceImage;
  File? _inspectionImage;
  bool _isSubmitting = false;

  @override
  void initState() {
    super.initState();
    _loadYears();
  }

  @override
  void dispose() {
    _colorController.dispose();
    _interiorColorController.dispose();
    _plateController.dispose();
    _zipController.dispose();
    super.dispose();
  }

  Future<void> _loadYears() async {
    setState(() => _loadingYears = true);
    try {
      final years = await AuthService.getVehicleYears();
      setState(() {
        _years = years;
        _loadingYears = false;
      });
    } catch (_) {
      // Fallback to a reasonable range
      final now = DateTime.now().year;
      setState(() {
        _years = List.generate(now - 2010, (i) => now - i);
        _loadingYears = false;
      });
    }
  }

  Future<void> _loadMakes(int year) async {
    setState(() => _loadingMakes = true);
    try {
      final makes = await AuthService.getVehicleMakes(year);
      setState(() {
        _makes = makes;
        _loadingMakes = false;
      });
    } catch (_) {
      setState(() {
        _makes = [];
        _loadingMakes = false;
      });
    }
  }

  Future<void> _loadModels(String make) async {
    setState(() => _loadingModels = true);
    try {
      final models = await AuthService.getVehicleModels(make, int.parse(_selectedYear!));
      setState(() {
        _models = models;
        _loadingModels = false;
      });
    } catch (_) {
      setState(() {
        _models = [];
        _loadingModels = false;
      });
    }
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_selectedYear == null || _selectedMake == null || _selectedModel == null) {
      _showError('Please select year, make, and model.');
      return;
    }
    if (_selectedState == null) {
      _showError('Please select your license plate state.');
      return;
    }
    if (_registrationImage == null) {
      _showError('Registration photo is required.');
      return;
    }
    if (_insuranceImage == null) {
      _showError('Insurance photo is required.');
      return;
    }
    if (_inspectionImage == null) {
      _showError('Inspection photo is required.');
      return;
    }

    setState(() => _isSubmitting = true);
    try {
      final regUrl = await AuthService.uploadImage(_registrationImage!);
      final insUrl = await AuthService.uploadImage(_insuranceImage!);
      final inspUrl = await AuthService.uploadImage(_inspectionImage!);

      await UserService.submitNewVehicle({
        'make': _selectedMake,
        'model': _selectedModel,
        'year': int.parse(_selectedYear!),
        'color': _colorController.text.trim(),
        'interior_color': _interiorColorController.text.trim(),
        'license_plate_number': _plateController.text.trim(),
        'license_plate_state': _selectedState,
        'zip_code': _zipController.text.trim(),
        'registration_photo_url': regUrl,
        'insurance_photo_url': insUrl,
        'inspection_photo_url': inspUrl,
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Vehicle submitted for admin review.')),
        );
        Navigator.pop(context, true);
      }
    } catch (e) {
      if (mounted) _showError('Failed to submit vehicle: $e');
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.red.shade700),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('Replace Vehicle', style: GoogleFonts.poppins(fontWeight: FontWeight.w700)),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Vehicle Details', style: GoogleFonts.poppins(fontSize: 18, fontWeight: FontWeight.w700)),
              const SizedBox(height: 16),

              // Year dropdown
              DropdownButtonFormField<String>(
                value: _selectedYear,
                decoration: const InputDecoration(labelText: 'Year', border: OutlineInputBorder()),
                isExpanded: true,
                items: (_loadingYears
                    ? <String>[]
                    : _years.map((y) => DropdownMenuItem(value: y.toString(), child: Text(y.toString()))).toList()),
                onChanged: (val) {
                  setState(() {
                    _selectedYear = val;
                    _selectedMake = null;
                    _selectedModel = null;
                    _makes = [];
                    _models = [];
                  });
                  if (val != null) _loadMakes(int.parse(val));
                },
                validator: (v) => v == null ? 'Required' : null,
              ),
              const SizedBox(height: 12),

              // Make dropdown
              DropdownButtonFormField<String>(
                value: _selectedMake,
                decoration: const InputDecoration(labelText: 'Make', border: OutlineInputBorder()),
                isExpanded: true,
                items: (_loadingMakes
                    ? <DropdownMenuItem<String>>[]
                    : _makes.map((m) => DropdownMenuItem(value: m, child: Text(m))).toList()),
                onChanged: _selectedYear == null
                    ? null
                    : (val) {
                        setState(() {
                          _selectedMake = val;
                          _selectedModel = null;
                          _models = [];
                        });
                        if (val != null) _loadModels(val);
                      },
                validator: (v) => v == null ? 'Required' : null,
              ),
              const SizedBox(height: 12),

              // Model dropdown
              DropdownButtonFormField<String>(
                value: _selectedModel,
                decoration: const InputDecoration(labelText: 'Model', border: OutlineInputBorder()),
                isExpanded: true,
                items: (_loadingModels
                    ? <DropdownMenuItem<String>>[]
                    : _models.map((m) => DropdownMenuItem(value: m, child: Text(m))).toList()),
                onChanged: _selectedMake == null
                    ? null
                    : (val) => setState(() => _selectedModel = val),
                validator: (v) => v == null ? 'Required' : null,
              ),
              const SizedBox(height: 12),

              TextFormField(
                controller: _colorController,
                decoration: const InputDecoration(labelText: 'Color', border: OutlineInputBorder()),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _interiorColorController,
                decoration: const InputDecoration(labelText: 'Interior Color (optional)', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _plateController,
                decoration: const InputDecoration(labelText: 'License Plate Number', border: OutlineInputBorder()),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : null,
              ),
              const SizedBox(height: 12),

              // State dropdown
              DropdownButtonFormField<String>(
                value: _selectedState,
                decoration: const InputDecoration(labelText: 'License Plate State', border: OutlineInputBorder()),
                isExpanded: true,
                items: _usStates.map((s) => DropdownMenuItem(value: s, child: Text(s))).toList(),
                onChanged: (val) => setState(() => _selectedState = val),
                validator: (v) => v == null ? 'Required' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _zipController,
                decoration: const InputDecoration(labelText: 'ZIP Code', border: OutlineInputBorder()),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Required' : null,
              ),
              const SizedBox(height: 24),
              Text('Upload Documents', style: GoogleFonts.poppins(fontSize: 18, fontWeight: FontWeight.w700)),
              const SizedBox(height: 12),
              _buildPhotoUpload('Vehicle Registration', _registrationImage, (f) => setState(() => _registrationImage = f)),
              const SizedBox(height: 12),
              _buildPhotoUpload('Regular Car Insurance', _insuranceImage, (f) => setState(() => _insuranceImage = f)),
              const SizedBox(height: 12),
              _buildPhotoUpload('Vehicle Inspection', _inspectionImage, (f) => setState(() => _inspectionImage = f)),
              const SizedBox(height: 32),
              ElevatedButton(
                onPressed: _isSubmitting ? null : _submit,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF5B7760),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                child: _isSubmitting
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : Text('Submit for Review', style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPhotoUpload(String label, File? file, ValueChanged<File?> onPicked) {
    return InkWell(
      onTap: () async {
        final picker = ImagePicker();
        final picked = await picker.pickImage(source: ImageSource.gallery);
        if (picked != null) onPicked(File(picked.path));
      },
      borderRadius: BorderRadius.circular(14),
      child: Container(
        height: 100,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: const Color(0xFFD8D2CA)),
          color: file != null ? Colors.black.withOpacity(0.03) : null,
        ),
        child: file != null
            ? ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    Image.file(file, fit: BoxFit.cover),
                    Positioned(
                      top: 4,
                      right: 4,
                      child: GestureDetector(
                        onTap: () => onPicked(null),
                        child: Container(
                          decoration: const BoxDecoration(color: Colors.black54, shape: BoxShape.circle),
                          padding: const EdgeInsets.all(4),
                          child: const Icon(Icons.close, size: 16, color: Colors.white),
                        ),
                      ),
                    ),
                  ],
                ),
              )
            : Center(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(Icons.camera_alt, color: Color(0xFF5B7760)),
                    const SizedBox(width: 8),
                    Text(label, style: const TextStyle(fontWeight: FontWeight.w600, color: Color(0xFF5B7760))),
                  ],
                ),
              ),
      ),
    );
  }
}
