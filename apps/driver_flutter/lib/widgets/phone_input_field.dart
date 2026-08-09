// lib/widgets/phone_input_field.dart
//
// SHARED, PRODUCTION-GRADE PHONE NUMBER INPUT
//
// Left: country selector (🇺🇸 United States (+1)) — extensible for more
//       countries via [CountryDialCode.supportedCountries].
// Right: numeric phone field with live US validation, auto-formatting,
//       digit-only input, and immediate invalid-character stripping.
//
// Exposes:
//   - [controller] the raw national-number digits (formatted for display)
//   - [isValid] whether exactly 10 valid US digits are entered
//   - [normalized] the E.164 value to send to the backend
//
// This is the single phone-entry component used across all auth screens so
// behavior (validation, formatting, accessibility) stays consistent.

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../utils/phone_utils.dart';

class PhoneInputField extends StatefulWidget {
  final TextEditingController controller;
  final CountryDialCode country;
  final ValueChanged<bool>? onValidityChanged;
  final InputDecoration? decoration;

  const PhoneInputField({
    super.key,
    required this.controller,
    this.country = CountryDialCode.unitedStates,
    this.onValidityChanged,
    this.decoration,
  });

  bool get isValid => PhoneUtils.isValid(controller.text, country: country);

  /// E.164 normalized value, or null if currently invalid.
  String? get normalized => PhoneUtils.normalize(
        input: controller.text,
        country: country,
      );

  @override
  State<PhoneInputField> createState() => _PhoneInputFieldState();
}

class _PhoneInputFieldState extends State<PhoneInputField> {
  late final TextEditingController _digitsController;
  final FocusNode _digitsFocus = FocusNode();

  @override
  void initState() {
    super.initState();
    _digitsController = widget.controller;
    _digitsController.addListener(_onChanged);
  }

  void _onChanged() {
    final formatted = PhoneUtils.formatUsDisplay(_digitsController.text, country: widget.country);
    if (formatted != _digitsController.text) {
      _digitsController.value = TextEditingValue(
        text: formatted,
        selection: TextSelection.collapsed(offset: formatted.length),
      );
    }
    widget.onValidityChanged?.call(widget.isValid);
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _digitsController.removeListener(_onChanged);
    _digitsFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final valid = widget.isValid;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // ── Country selector ────────────────────────────────────────
        Container(
          height: 56, // match the text field height for alignment
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: Color(0xFF315646),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Color(0xFF3D5F4D)),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<CountryDialCode>(
              value: widget.country,
              icon: const Icon(Icons.arrow_drop_down, size: 20),
              items: CountryDialCode.supportedCountries
                  .map(
                    (c) => DropdownMenuItem(
                      value: c,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(c.flag, style: const TextStyle(fontSize: 20)),
                          const SizedBox(width: 8),
                          Text(
                            c.dialCode,
                            style: GoogleFonts.poppins(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFFD0CFBA),
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                  .toList(),
              onChanged: null, // single country for this release; extensible later
              // Accessibility: announce the selected country.
              selectedItemBuilder: (context) => CountryDialCode.supportedCountries
                  .map((c) => Semantics(
                        label: c.selectorLabel,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(c.flag, style: const TextStyle(fontSize: 20)),
                            const SizedBox(width: 8),
                            Text(c.dialCode, style: GoogleFonts.poppins(fontSize: 15, fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ))
                  .toList(),
            ),
          ),
        ),
        const SizedBox(width: 12),
        // ── Numeric phone field ─────────────────────────────────────
        Expanded(
          child: TextFormField(
            controller: _digitsController,
            focusNode: _digitsFocus,
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.done,
            autofillHints: const [AutofillHints.telephoneNumberNational],
            maxLength: 14, // (555) 123-4567 -> 14 chars
            style: GoogleFonts.poppins(fontSize: 16),
            decoration: (widget.decoration ??
                    InputDecoration(
                      hintText: '(555) 123-4567',
                      counterText: '',
                      filled: true,
                      fillColor: Color(0xFF315646),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide.none,
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFFD0CFBA), width: 1.5),
                      ),
                      errorBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Colors.redAccent, width: 1),
                      ),
                    ))
                .copyWith(
              // Visual validity cue without relying on color alone.
              suffixIcon: valid
                  ? const Icon(Icons.check_circle_rounded, color: Colors.green)
                  : null,
            ),
            // Live validation message (accessible text, not color-only).
            validator: (value) {
              if (value == null || value.isEmpty) return 'Enter your phone number';
              if (!PhoneUtils.isValid(value, country: widget.country)) {
                return 'Please enter a valid 10-digit US phone number.';
              }
              return null;
            },
          ),
        ),
      ],
    );
  }
}
