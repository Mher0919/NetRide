import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../services/auth_service.dart';
import '../services/error_handler.dart';
import 'verification_screen.dart';

class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key});

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();
  bool _isLoading = false;
  bool _obscurePassword = true;

  bool _hasMinLength = false;
  bool _hasCapitalLetter = false;
  bool _hasNumber = false;
  bool _hasSpecialChar = false;

  @override
  void initState() {
    super.initState();
    _passwordController.addListener(_onPasswordChanged);
    _confirmPasswordController.addListener(_onConfirmPasswordChanged);
  }

  @override
  void dispose() {
    _passwordController.removeListener(_onPasswordChanged);
    _confirmPasswordController.removeListener(_onConfirmPasswordChanged);
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    _confirmPasswordController.dispose();
    super.dispose();
  }

  void _onPasswordChanged() {
    final password = _passwordController.text;
    final hasMinLength = password.length >= 8;
    final hasCapitalLetter = password.contains(RegExp(r'[A-Z]'));
    final hasNumber = password.contains(RegExp(r'[0-9]'));
    final hasSpecialChar = password.contains(RegExp(r'[!@#\$%^&*(),.?":{}|<>\-_+=~`|\\\[\]]'));

    setState(() {
      _hasMinLength = hasMinLength;
      _hasCapitalLetter = hasCapitalLetter;
      _hasNumber = hasNumber;
      _hasSpecialChar = hasSpecialChar;
    });
  }

  void _onConfirmPasswordChanged() {
    setState(() {});
  }

  bool get _allCheckpointsMet => _hasMinLength && _hasCapitalLetter && _hasNumber && _hasSpecialChar;

  Future<void> _handleSignup() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isLoading = true);
    try {
      final res = await AuthService.signupWithPassword(
        email: _emailController.text.trim(),
        fullName: _nameController.text.trim(),
        password: _passwordController.text.trim(),
        role: 'DRIVER',
      );
      if (mounted) {
        if (res['otp_required'] == true) {
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (context) => VerificationScreen(
                email: _emailController.text.trim(),
                role: 'DRIVER',
              ),
            ),
          );
        } else {
          // Fallback
          Navigator.pushNamedAndRemoveUntil(
            context, 
            '/splash', 
            (route) => false,
            arguments: {'targetRoute': '/onboarding'},
          );
        }
      }
    } catch (e) {
      if (mounted) {
        final message = ErrorHandler.friendly(
          e,
          fallback: 'We couldn\'t create your account. Please try again.',
        );
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(message),
            backgroundColor: Colors.redAccent,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF294C3A),
      appBar: AppBar(
        backgroundColor: const Color(0xFF294C3A),
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, color: Color(0xFFD0CFBA), size: 20),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24.0),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 20),
                Center(
                  child: Hero(
                    tag: 'auth_icon',
                    child: Image.asset(
                      'assets/images/logo.png',
                      width: 120,
                      height: 120,
                      fit: BoxFit.contain,
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  'Drive with NetRide',
                  style: GoogleFonts.poppins(
                    fontSize: 28,
                    fontWeight: FontWeight.bold,
                    letterSpacing: -0.5,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Sign up now to start earning.',
                  style: GoogleFonts.poppins(
                    fontSize: 16,
                    color: Color(0xFF9BAE9E),
                  ),
                ),
                const SizedBox(height: 32),
                _buildTextField(
                  label: 'Full Name',
                  controller: _nameController,
                  icon: Icons.person_outline_rounded,
                  validator: (val) => val!.isEmpty ? 'Please enter your name' : null,
                ),
                const SizedBox(height: 16),
                _buildTextField(
                  label: 'Email Address',
                  controller: _emailController,
                  icon: Icons.email_outlined,
                  keyboardType: TextInputType.emailAddress,
                  validator: (val) => !val!.contains('@') ? 'Invalid email' : null,
                ),
                const SizedBox(height: 16),
                _buildTextField(
                  label: 'Password',
                  controller: _passwordController,
                  icon: Icons.lock_outline_rounded,
                  obscureText: _obscurePassword,
                  suffixIcon: IconButton(
                    icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility, color: Colors.grey),
                    onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                  ),
                  validator: (val) {
                    if (val == null || val.isEmpty) return 'Please enter a password';
                    if (!_allCheckpointsMet) return 'Password does not meet all checkpoints';
                    return null;
                  },
                ),
                _buildPasswordCheckpoints(),
                const SizedBox(height: 16),
                _buildTextField(
                  label: 'Confirm Password',
                  controller: _confirmPasswordController,
                  icon: Icons.lock_reset_rounded,
                  obscureText: _obscurePassword,
                  enabled: _allCheckpointsMet,
                  validator: (val) {
                    if (val == null || val.isEmpty) return 'Please confirm your password';
                    if (val != _passwordController.text) return 'Passwords do not match';
                    return null;
                  },
                ),
                const SizedBox(height: 40),
                SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: ElevatedButton(
                    onPressed: (_isLoading || !_allCheckpointsMet || _passwordController.text != _confirmPasswordController.text)
                        ? null
                        : _handleSignup,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFD0CFBA),
                      foregroundColor: const Color(0xFF294C3A),
                      elevation: 0,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: _isLoading
                        ? const SizedBox(
                            height: 24,
                            width: 24,
                            child: CircularProgressIndicator(color: Color(0xFF294C3A), strokeWidth: 2),
                          )
                        : Text(
                            'Sign Up',
                            style: GoogleFonts.poppins(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                  ),
                ),
                const SizedBox(height: 20),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPasswordCheckpoints() {
    return Padding(
      padding: const EdgeInsets.only(top: 8.0, left: 4.0, right: 4.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildCheckpointRow('At least 8 characters', _hasMinLength),
          const SizedBox(height: 6),
          _buildCheckpointRow('One capital letter', _hasCapitalLetter),
          const SizedBox(height: 6),
          _buildCheckpointRow('One number', _hasNumber),
          const SizedBox(height: 6),
          _buildCheckpointRow('One special character', _hasSpecialChar),
        ],
      ),
    );
  }

  Widget _buildCheckpointRow(String text, bool isMet) {
    return Row(
      children: [
        Icon(
          isMet ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
          color: isMet ? const Color(0xFF7FAE8C) : Colors.grey[500],
          size: 16,
        ),
        const SizedBox(width: 8),
        Text(
          text,
          style: GoogleFonts.poppins(
            fontSize: 12,
            color: isMet ? const Color(0xFF7FAE8C) : Colors.grey[500],
            fontWeight: isMet ? FontWeight.w500 : FontWeight.normal,
          ),
        ),
      ],
    );
  }

  Widget _buildTextField({
    required String label,
    required TextEditingController controller,
    required IconData icon,
    TextInputType? keyboardType,
    bool obscureText = false,
    Widget? suffixIcon,
    String? Function(String?)? validator,
    bool? enabled,
  }) {
    final isFieldEnabled = enabled ?? true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: GoogleFonts.poppins(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: isFieldEnabled ? Color(0xFFD0CFBA) : Color(0xFF9BAE9E).withOpacity(0.6),
          ),
        ),
        const SizedBox(height: 8),
        TextFormField(
          controller: controller,
          keyboardType: keyboardType,
          obscureText: obscureText,
          validator: validator,
          cursorColor: const Color(0xFFD0CFBA),
          enabled: enabled,
          style: GoogleFonts.poppins(color: const Color(0xFFD0CFBA), fontSize: 15),
          decoration: InputDecoration(
            prefixIcon: Icon(icon, color: isFieldEnabled ? Color(0xFF9BAE9E) : Color(0xFF9BAE9E).withOpacity(0.5), size: 22),
            suffixIcon: suffixIcon,
            hintText: 'Enter your $label',
            hintStyle: GoogleFonts.poppins(color: Color(0xFF9BAE9E), fontSize: 15),
            filled: true,
            fillColor: isFieldEnabled ? const Color(0xFF315646) : const Color(0xFF294C3A),
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
            disabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: BorderSide.none,
            ),
          ),
        ),
      ],
    );
  }
}

