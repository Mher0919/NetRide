// lib/utils/phone_utils.dart
//
// CENTRALIZED PHONE NUMBER HANDLING
//
// Provides:
//   - A country dial-code model (extensible for future countries).
//   - US-only selection for the current release (+1), with the
//     architecture ready to add more countries without UI changes.
//   - Normalization to E.164 (e.g. +15551234567) for backend storage.
//   - User-facing formatting (e.g. (555) 123-4567) for the input field.
//   - Validation (exactly 10 US digits for this release).
//
// All phone parsing/validation MUST go through these helpers so the two
// apps stay consistent and there is a single source of truth.

class CountryDialCode {
  final String name;
  final String flag;
  final String dialCode; // includes '+'
  final int minLength;
  final int maxLength;
  final bool hasStateCode; // e.g. US/CA country code is part of the NANP

  const CountryDialCode({
    required this.name,
    required this.flag,
    required this.dialCode,
    required this.minLength,
    required this.maxLength,
    this.hasStateCode = false,
  });

  /// The only selectable country for the current release.
  /// Extend this list later to support more countries — the UI consumes
  /// [supportedCountries], so no screen changes are required.
  static const CountryDialCode unitedStates = CountryDialCode(
    name: 'United States',
    flag: '🇺🇸',
    dialCode: '+1',
    minLength: 10,
    maxLength: 10,
    hasStateCode: true,
  );

  static const List<CountryDialCode> supportedCountries = [unitedStates];

  /// Display label used in the country selector, e.g. "🇺🇸 United States (+1)".
  String get selectorLabel => '$flag $name ($dialCode)';
}

class PhoneUtils {
  PhoneUtils._();

  /// Strip every non-digit character.
  static String digitsOnly(String input) => input.replaceAll(RegExp(r'\D'), '');

  /// Whether the raw input contains any letter (reject/ignore as needed).
  static bool hasLetters(String input) => input.contains(RegExp(r'[a-zA-Z]'));

  /// Normalize a user-entered phone number into E.164 for the backend.
  ///
  /// For this release the only supported country is the US (+1), so a valid
  /// 10-digit US number becomes +1XXXXXXXXXX. The [country] parameter makes
  /// this future-proof for additional countries.
  static String? normalize({
    required String input,
    CountryDialCode country = CountryDialCode.unitedStates,
  }) {
    final digits = digitsOnly(input);
    if (!isValidUsInput(digits, country: country)) return null;
    return '${country.dialCode}$digits';
  }

  /// Validate that the digit string is a complete, valid number for [country].
  static bool isValidUsInput(String digits, {CountryDialCode country = CountryDialCode.unitedStates}) {
    if (digits.isEmpty) return false;
    if (digits.length < country.minLength || digits.length > country.maxLength) return false;
    // For this release, US numbers must be exactly 10 digits.
    if (country == CountryDialCode.unitedStates && digits.length != 10) return false;
    // US numbers cannot start with 0 or 1.
    if (country == CountryDialCode.unitedStates) {
      final first = digits[0];
      if (first == '0' || first == '1') return false;
    }
    return true;
  }

  /// Convenience: is the full input (digits only) valid for [country]?
  static bool isValid(String input, {CountryDialCode country = CountryDialCode.unitedStates}) {
    return isValidUsInput(digitsOnly(input), country: country);
  }

  /// Format US digits progressively as the user types, e.g.:
  ///   555 -> 555
  ///   555123 -> (555) 123
  ///   5551234567 -> (555) 123-4567
  static String formatUsDisplay(String input, {CountryDialCode country = CountryDialCode.unitedStates}) {
    final d = digitsOnly(input);
    if (country == CountryDialCode.unitedStates) {
      return _fmtPartial(d);
    }
    return d;
  }

  static String _fmtPartial(String d) {
    // d is 1..10 digits
    if (d.length <= 3) return d;
    if (d.length <= 6) return '(${d.substring(0, 3)}) ${d.substring(3)}';
    return '(${d.substring(0, 3)}) ${d.substring(3, 6)}-${d.substring(6)}';
  }

  /// Return only the national number (digits without country code) from an
  /// E.164 string, for pre-filling the input field from a stored value.
  static String nationalNumber(String e164, {CountryDialCode country = CountryDialCode.unitedStates}) {
    final digits = digitsOnly(e164);
    final cc = country.dialCode.replaceAll('+', '');
    if (digits.startsWith(cc)) return digits.substring(cc.length);
    return digits;
  }
}
