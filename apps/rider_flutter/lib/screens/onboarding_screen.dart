import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../services/auth_service.dart';

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

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _requestOTP() async {
    if (_phoneController.text.isEmpty) {
      _showError('Please enter your phone number');
      return;
    }

    setState(() => _isLoading = true);
    try {
      await AuthService.requestPhoneOTP(_phoneController.text.trim());
      setState(() => _codeSent = true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Verification code sent!')),
        );
      }
    } catch (e) {
      _showError('Failed to send code: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _verifyAndSubmit() async {
    String code = _codeControllers.map((c) => c.text).join();
    if (code.length < 4) {
      _showError('Please enter the full code');
      return;
    }

    setState(() => _isLoading = true);
    try {
      final phoneNumber = _phoneController.text.trim();
      await AuthService.verifyPhoneOTP(
        phoneNumber: phoneNumber,
        code: code,
      );
      
      if (mounted) {
        Navigator.pushReplacementNamed(context, '/');
      }
    } catch (e) {
      _showError('Verification failed: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
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
                  ? 'Enter the code sent to your phone.'
                  : 'Verify your phone number to start riding.',
                style: GoogleFonts.poppins(fontSize: 16, color: Colors.grey[600]),
              ),
              const SizedBox(height: 48),
              if (!_codeSent) ...[
                TextField(
                  controller: _phoneController,
                  keyboardType: TextInputType.phone,
                  decoration: InputDecoration(
                    labelText: 'Phone Number',
                    hintText: '+15550000000',
                    helperText: 'Include country code (e.g., +1)',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: const BorderSide(color: Colors.black, width: 2),
                    ),
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
                  onPressed: _isLoading 
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
        maxLength: 1,
        style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
        decoration: InputDecoration(
          counterText: "",
          filled: true,
          fillColor: Colors.grey.shade50,
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
