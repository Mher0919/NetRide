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

const _commonColors = [
  'Black', 'White', 'Silver', 'Gray', 'Blue', 'Red',
  'Green', 'Brown', 'Beige', 'Gold', 'Orange', 'Yellow', 'Purple',
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
  final _makeSearchController = TextEditingController();
  final _modelSearchController = TextEditingController();
  final _colorSearchController = TextEditingController();

  String? _selectedYear;
  String? _selectedMake;
  String? _selectedModel;
  String? _selectedState;

  List<int> _years = [];
  List<String> _makes = [];
  List<String> _models = [];
  List<String> _filteredMakes = [];
  List<String> _filteredModels = [];
  List<String> _filteredColors = [];
  bool _loadingYears = true;
  bool _loadingMakes = false;
  bool _loadingModels = false;
  bool _isCustomMake = false;
  bool _isCustomModel = false;
  bool _isCustomColor = false;

  File? _registrationImage;
  File? _insuranceImage;
  File? _inspectionImage;
  bool _isSubmitting = false;

  // Focus nodes for search fields
  final _makeFocusNode = FocusNode();
  final _modelFocusNode = FocusNode();
  final _colorFocusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    _loadYears();
    _makeSearchController.addListener(_onMakeSearchChanged);
    _modelSearchController.addListener(_onModelSearchChanged);
    _colorSearchController.addListener(_onColorSearchChanged);
  }

  @override
  void dispose() {
    _colorController.dispose();
    _interiorColorController.dispose();
    _plateController.dispose();
    _zipController.dispose();
    _makeSearchController.dispose();
    _modelSearchController.dispose();
    _colorSearchController.dispose();
    _makeFocusNode.dispose();
    _modelFocusNode.dispose();
    _colorFocusNode.dispose();
    super.dispose();
  }

  void _onMakeSearchChanged() {
    final query = _makeSearchController.text.toLowerCase();
    setState(() {
      _filteredMakes = _makes
          .where((m) => m.toLowerCase().contains(query))
          .toList();
    });
  }

  void _onModelSearchChanged() {
    final query = _modelSearchController.text.toLowerCase();
    setState(() {
      _filteredModels = _models
          .where((m) => m.toLowerCase().contains(query))
          .toList();
    });
  }

  void _onColorSearchChanged() {
    final query = _colorSearchController.text.toLowerCase();
    setState(() {
      _filteredColors = _commonColors
          .where((c) => c.toLowerCase().contains(query))
          .toList();
    });
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
      final now = DateTime.now().year;
      setState(() {
        _years = List.generate(now - 2010, (i) => now - i);
        _loadingYears = false;
      });
    }
  }

  Future<void> _loadMakes() async {
    setState(() => _loadingMakes = true);
    try {
      final makes = await AuthService.getVehicleMakes(0);
      setState(() {
        _makes = makes;
        _filteredMakes = makes;
        _loadingMakes = false;
      });
    } catch (_) {
      setState(() {
        _makes = [];
        _filteredMakes = [];
        _loadingMakes = false;
      });
    }
  }

  Future<void> _loadModels(String make) async {
    setState(() => _loadingModels = true);
    try {
      final models = await AuthService.getVehicleModels(make, 0);
      setState(() {
        _models = models;
        _filteredModels = models;
        _loadingModels = false;
      });
    } catch (_) {
      setState(() {
        _models = [];
        _filteredModels = [];
        _loadingModels = false;
      });
    }
  }

  void _selectMake(String make) {
    setState(() {
      _selectedMake = make;
      _isCustomMake = false;
      _selectedModel = null;
      _isCustomModel = false;
      _models = [];
      _filteredModels = [];
      _modelSearchController.clear();
      _makeSearchController.clear();
    });
    _loadModels(make);
    FocusScope.of(context).requestFocus(_modelFocusNode);
  }

  void _selectCustomMake() {
    final value = _makeSearchController.text.trim();
    if (value.isEmpty) return;
    setState(() {
      _selectedMake = value;
      _isCustomMake = true;
      _selectedModel = null;
      _isCustomModel = false;
      _models = [];
      _filteredModels = [];
      _modelSearchController.clear();
      _makeSearchController.clear();
    });
    FocusScope.of(context).requestFocus(_modelFocusNode);
  }

  void _selectModel(String model) {
    setState(() {
      _selectedModel = model;
      _isCustomModel = false;
      _modelSearchController.clear();
    });
  }

  void _selectCustomModel() {
    final value = _modelSearchController.text.trim();
    if (value.isEmpty) return;
    setState(() {
      _selectedModel = value;
      _isCustomModel = true;
      _modelSearchController.clear();
    });
  }

  void _selectColor(String color) {
    setState(() {
      _colorController.text = color;
      _isCustomColor = false;
      _colorSearchController.clear();
    });
  }

  void _selectCustomColor() {
    final value = _colorSearchController.text.trim();
    if (value.isEmpty) return;
    setState(() {
      _colorController.text = value;
      _isCustomColor = true;
      _colorSearchController.clear();
    });
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_selectedYear == null) {
      _showError('Please select the vehicle year.');
      return;
    }
    if (_selectedMake == null) {
      _showError('Please select or enter the vehicle make.');
      return;
    }
    if (_selectedModel == null) {
      _showError('Please select or enter the vehicle model.');
      return;
    }
    if (_colorController.text.trim().isEmpty) {
      _showError('Please select or enter the vehicle color.');
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
      _showError('Car Insurance photo is required.');
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
        'make': _selectedMake!.trim(),
        'model': _selectedModel!.trim(),
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
                    ? <DropdownMenuItem<String>>[]
                    : _years.map((y) => DropdownMenuItem<String>(value: y.toString(), child: Text(y.toString()))).toList()),
                onChanged: (val) {
                  setState(() {
                    _selectedYear = val;
                    _selectedMake = null;
                    _selectedModel = null;
                    _isCustomMake = false;
                    _isCustomModel = false;
                    _makes = [];
                    _models = [];
                    _filteredMakes = [];
                    _filteredModels = [];
                    _makeSearchController.clear();
                    _modelSearchController.clear();
                  });
                  if (val != null) _loadMakes();
                },
                validator: (v) => v == null ? 'Required' : null,
              ),
              const SizedBox(height: 12),

              // Make — searchable with custom entry
              _buildSearchableField(
                label: 'Make',
                controller: _makeSearchController,
                focusNode: _makeFocusNode,
                value: _selectedMake,
                isCustom: _isCustomMake,
                filteredItems: _filteredMakes,
                loading: _loadingMakes,
                onSelect: _selectMake,
                onCustom: _selectCustomMake,
                onClear: () {
                  setState(() {
                    _selectedMake = null;
                    _isCustomMake = false;
                    _selectedModel = null;
                    _isCustomModel = false;
                    _models = [];
                    _filteredModels = [];
                    _modelSearchController.clear();
                    _makeSearchController.clear();
                  });
                },
                enabled: _selectedYear != null,
                displayValue: _selectedMake != null
                    ? '$_selectedMake${_isCustomMake ? ' (custom)' : ''}'
                    : null,
              ),
              const SizedBox(height: 12),

              // Model — searchable with custom entry
              _buildSearchableField(
                label: 'Model',
                controller: _modelSearchController,
                focusNode: _modelFocusNode,
                value: _selectedModel,
                isCustom: _isCustomModel,
                filteredItems: _filteredModels,
                loading: _loadingModels,
                onSelect: _selectModel,
                onCustom: _selectCustomModel,
                onClear: () {
                  setState(() {
                    _selectedModel = null;
                    _isCustomModel = false;
                    _modelSearchController.clear();
                  });
                },
                enabled: _selectedMake != null,
                displayValue: _selectedModel != null
                    ? '$_selectedModel${_isCustomModel ? ' (custom)' : ''}'
                    : null,
              ),
              const SizedBox(height: 12),

              // Color — searchable dropdown with common colors + custom
              _buildColorField(),
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
              _buildPhotoUpload('Car Insurance', _insuranceImage, (f) => setState(() => _insuranceImage = f)),
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

  Widget _buildSearchableField({
    required String label,
    required TextEditingController controller,
    required FocusNode focusNode,
    required String? value,
    required bool isCustom,
    required List<String> filteredItems,
    required bool loading,
    required Function(String) onSelect,
    required VoidCallback onCustom,
    required VoidCallback onClear,
    required bool enabled,
    String? displayValue,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (displayValue != null)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            decoration: BoxDecoration(
              border: Border.all(color: const Color(0xFF5B7760)),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(displayValue, style: const TextStyle(fontSize: 16)),
                ),
                GestureDetector(
                  onTap: onClear,
                  child: const Icon(Icons.close, size: 18, color: Colors.grey),
                ),
              ],
            ),
          )
        else ...[
          TextField(
            controller: controller,
            focusNode: focusNode,
            enabled: enabled,
            decoration: InputDecoration(
              labelText: enabled ? 'Search $label' : 'Select year first',
              border: const OutlineInputBorder(),
              suffixIcon: controller.text.isNotEmpty
                  ? IconButton(
                      icon: const Icon(Icons.clear, size: 18),
                      onPressed: () => controller.clear(),
                    )
                  : null,
            ),
          ),
          if (enabled && focusNode.hasFocus && controller.text.isNotEmpty) ...[
            const SizedBox(height: 4),
            Container(
              constraints: const BoxConstraints(maxHeight: 200),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.grey.shade300),
                borderRadius: BorderRadius.circular(4),
                color: Colors.white,
              ),
              child: loading
                  ? const Center(child: Padding(
                      padding: EdgeInsets.all(16),
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ))
                  : ListView(
                      shrinkWrap: true,
                      children: [
                        ...filteredItems.map((item) => ListTile(
                          dense: true,
                          title: Text(item),
                          onTap: () => onSelect(item),
                        )),
                        if (controller.text.trim().isNotEmpty &&
                            !filteredItems.any((i) =>
                                i.toLowerCase() == controller.text.trim().toLowerCase()))
                          ListTile(
                            dense: true,
                            leading: const Icon(Icons.add_circle_outline, size: 18),
                            title: Text('Use "${controller.text.trim()}"'),
                            onTap: onCustom,
                          ),
                      ],
                    ),
            ),
          ],
        ],
      ],
    );
  }

  Widget _buildColorField() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_colorController.text.isNotEmpty)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            decoration: BoxDecoration(
              border: Border.all(color: const Color(0xFF5B7760)),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '${_colorController.text}${_isCustomColor ? ' (custom)' : ''}',
                    style: const TextStyle(fontSize: 16),
                  ),
                ),
                GestureDetector(
                  onTap: () {
                    setState(() {
                      _colorController.clear();
                      _isCustomColor = false;
                    });
                  },
                  child: const Icon(Icons.close, size: 18, color: Colors.grey),
                ),
              ],
            ),
          )
        else ...[
          TextField(
            controller: _colorSearchController,
            decoration: const InputDecoration(
              labelText: 'Search Color',
              border: OutlineInputBorder(),
              hintText: 'e.g. Midnight Blue',
            ),
          ),
          if (_colorSearchController.text.isNotEmpty) ...[
            const SizedBox(height: 4),
            Container(
              constraints: const BoxConstraints(maxHeight: 200),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.grey.shade300),
                borderRadius: BorderRadius.circular(4),
                color: Colors.white,
              ),
              child: ListView(
                shrinkWrap: true,
                children: [
                  ..._filteredColors.map((color) => ListTile(
                    dense: true,
                    title: Row(
                      children: [
                        Container(
                          width: 20,
                          height: 20,
                          margin: const EdgeInsets.only(right: 12),
                          decoration: BoxDecoration(
                            color: _colorToSwatch(color),
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: Colors.grey.shade300),
                          ),
                        ),
                        Text(color),
                      ],
                    ),
                    onTap: () => _selectColor(color),
                  )),
                  if (_colorSearchController.text.trim().isNotEmpty &&
                      !_commonColors.any((c) =>
                          c.toLowerCase() == _colorSearchController.text.trim().toLowerCase()))
                    ListTile(
                      dense: true,
                      leading: const Icon(Icons.add_circle_outline, size: 18),
                      title: Text('Use "${_colorSearchController.text.trim()}"'),
                      onTap: _selectCustomColor,
                    ),
                ],
              ),
            ),
          ],
        ],
      ],
    );
  }

  Color _colorToSwatch(String color) {
    switch (color.toLowerCase()) {
      case 'black': return Colors.black;
      case 'white': return Colors.white;
      case 'silver': return Colors.grey.shade300;
      case 'gray': return Colors.grey.shade500;
      case 'blue': return Colors.blue;
      case 'red': return Colors.red;
      case 'green': return Colors.green;
      case 'brown': return Colors.brown;
      case 'beige': return Colors.yellow.shade100;
      case 'gold': return Colors.amber;
      case 'orange': return Colors.orange;
      case 'yellow': return Colors.yellow;
      case 'purple': return Colors.purple;
      default: return Colors.grey;
    }
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
