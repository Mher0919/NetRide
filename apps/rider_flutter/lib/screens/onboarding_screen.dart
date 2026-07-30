import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/auth_service.dart';
import '../services/error_handler.dart';
import '../utils/phone_utils.dart';
import '../widgets/phone_input_field.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final _phoneController = TextEditingController();
  final List<TextEditingController> _codeControllers = List.generate(6, (_) => TextEditingController());
  final List<FocusNode> _focusNodes = List.generate(6, (_) => FocusNode());

  bool _isLoading = false;
  bool _codeSent = false;
  bool _phoneValid = false;

  // Transient UI-progress flag so a restart/resume returns the user to the
  // correct onboarding sub-step. NOTE: this is NOT the completion signal —
  // completion is always derived from the backend (phone_verified).
  static const String _kPhoneStep = 'onboarding_phone_step';

  @override
  void initState() {
    super.initState();
    _restoreProgress();
  }

  Future<void> _restoreProgress() async {
    final prefs = await SharedPreferences.getInstance();
    final step = prefs.getString(_kPhoneStep);
    if (step == 'code_sent' && mounted) {
      setState(() => _codeSent = true);
    }
  }

  Future<void> _persistCodeSent() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kPhoneStep, 'code_sent');
  }

  Future<void> _clearProgress() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kPhoneStep);
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.redAccent),
    );
  }

  Future<void> _requestOTP() async {
    // Frontend gate: only enabled when valid, but double-check anyway.
    final normalized = PhoneUtils.normalize(input: _phoneController.text);
    if (normalized == null) {
      _showError(ErrorHandler.invalidPhone());
      return;
    }

    setState(() => _isLoading = true);
    try {
      final result = await AuthService.requestPhoneOTP(normalized);

      // Backend short-circuits when the number is already verified on this
      // account (e.g. re-onboarding, or verified via another app profile).
      // In that case no SMS is sent — complete onboarding directly instead
      // of stranding the user on a code-entry screen with no code.
      if (result != null && result['auto_verified'] == true) {
        await _clearProgress();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Phone already verified.')),
          );
          Navigator.pushReplacementNamed(context, '/');
        }
        return;
      }

      await _persistCodeSent();
      setState(() => _codeSent = true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Verification code sent!')),
        );
      }
    } catch (e) {
      // Backend validation still exists; translate any failure safely.
      _showError(ErrorHandler.friendly(e, fallback: ErrorHandler.unableToSendCode()));
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _verifyAndSubmit() async {
    String code = _codeControllers.map((c) => c.text).join();
    if (code.length < 6) {
      _showError('Please enter the full 6-digit code');
      return;
    }

    final normalized = PhoneUtils.normalize(input: _phoneController.text);
    if (normalized == null) {
      _showError(ErrorHandler.invalidPhone());
      return;
    }

    setState(() => _isLoading = true);
    try {
      await AuthService.verifyPhoneOTP(
        phoneNumber: normalized,
        code: code,
      );

      await _clearProgress();

      if (mounted) {
        Navigator.pushReplacementNamed(context, '/');
      }
    } catch (e) {
      _showError(ErrorHandler.friendly(e, fallback: ErrorHandler.incorrectCode()));
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  void dispose() {
    _phoneController.dispose();
    for (final c in _codeControllers) c.dispose();
    for (final f in _focusNodes) f.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFEEEBE6),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 40),
              Text(
                'Welcome to NetRide',
                style: GoogleFonts.poppins(fontSize: 28, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 12),
              Text(
                _codeSent
                    ? 'Enter the 6-digit code sent to\n${_phoneController.text}'
                    : 'Verify your phone number to start riding.',
                style: GoogleFonts.poppins(fontSize: 16, color: Colors.grey[600]),
              ),
              const SizedBox(height: 48),
              if (!_codeSent) ...[
                PhoneInputField(
                  controller: _phoneController,
                  onValidityChanged: (valid) {
                    if (_phoneValid != valid) setState(() => _phoneValid = valid);
                  },
                ),
                const SizedBox(height: 8),
                Text(
                  _phoneValid
                      ? 'Looks good — tap Send Code to continue.'
                      : 'Enter your 10-digit US phone number.',
                  style: GoogleFonts.poppins(
                    fontSize: 12,
                    color: _phoneValid ? Colors.green[700] : Colors.grey[600],
                  ),
                ),
              ] else ...[
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: List.generate(6, (index) => _buildDigitBox(index)),
                ),
                const SizedBox(height: 24),
                Center(
                  child: TextButton(
                    onPressed: _isLoading ? null : () => setState(() => _codeSent = false),
                    child: Text(
                      "Change phone number",
                      style: GoogleFonts.poppins(color: Colors.blue[700]),
                    ),
                  ),
                ),
              ],
              const Spacer(),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton(
                  onPressed: _isLoading || !_phoneValid
                      ? null
                      : (_codeSent ? _verifyAndSubmit : _requestOTP),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.black,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: _isLoading
                      ? const CircularProgressIndicator(color: Colors.white)
                      : Text(
                          _codeSent ? 'Verify & Finish' : 'Send Code',
                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildDigitBox(int index) {
    return SizedBox(
      width: 45,
      height: 55,
      child: TextField(
        controller: _codeControllers[index],
        focusNode: _focusNodes[index],
        keyboardType: TextInputType.number,
        textAlign: TextAlign.center,
        textAlignVertical: TextAlignVertical.center,
        maxLength: 1,
        cursorColor: Colors.black,
        style: const TextStyle(
          fontSize: 24,
          fontWeight: FontWeight.bold,
          color: Colors.black,
        ),
        decoration: InputDecoration(
          counterText: "",
          filled: true,
          fillColor: Colors.grey.shade50,
          contentPadding: EdgeInsets.zero,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Colors.black, width: 1.5),
          ),
        ),
        onChanged: (value) {
          if (value.isNotEmpty && index < 5) {
            _focusNodes[index + 1].requestFocus();
          } else if (value.isEmpty && index > 0) {
            _focusNodes[index - 1].requestFocus();
          }

          if (_codeControllers.every((c) => c.text.isNotEmpty)) {
            _verifyAndSubmit();
          }
        },
      ),
    );
  }
}
