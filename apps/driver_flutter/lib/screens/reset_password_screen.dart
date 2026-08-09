import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../services/auth_service.dart';
import '../services/error_handler.dart';

class ResetPasswordScreen extends StatefulWidget {
  final String? token;
  const ResetPasswordScreen({super.key, this.token});

  @override
  State<ResetPasswordScreen> createState() => _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends State<ResetPasswordScreen> {
  final _tokenController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();
  bool _isLoading = false;
  bool _obscure = true;

  bool _hasMinLength = false;
  bool _hasCapitalLetter = false;
  bool _hasNumber = false;
  bool _hasSpecialChar = false;

  @override
  void initState() {
    super.initState();
    if (widget.token != null) {
      _tokenController.text = widget.token!;
    }
    _passwordController.addListener(_onPasswordChanged);
    _confirmPasswordController.addListener(_onConfirmPasswordChanged);
  }

  @override
  void dispose() {
    _passwordController.removeListener(_onPasswordChanged);
    _confirmPasswordController.removeListener(_onConfirmPasswordChanged);
    _tokenController.dispose();
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

  Future<void> _handleReset() async {
    if (_tokenController.text.isEmpty || _passwordController.text.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Please fill all fields')));
      return;
    }
    if (!_allCheckpointsMet) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Password does not meet all checkpoints')));
      return;
    }
    if (_passwordController.text != _confirmPasswordController.text) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Passwords do not match')));
      return;
    }

    setState(() => _isLoading = true);
    try {
      await AuthService.resetPassword(_tokenController.text.trim(), _passwordController.text.trim());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Password reset successful. Please login.')));
        Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
      }
    } catch (e) {
      if (mounted) {
        final message = ErrorHandler.friendly(
          e,
          fallback: 'We couldn\'t reset your password. Please try again.',
        );
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(message), backgroundColor: Colors.redAccent),
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
      appBar: AppBar(backgroundColor: const Color(0xFF294C3A), elevation: 0, leading: const BackButton(color: Color(0xFFD0CFBA))),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Reset Password', style: GoogleFonts.poppins(fontSize: 28, fontWeight: FontWeight.bold, color: const Color(0xFFD0CFBA))),
              const SizedBox(height: 8),
              Text('Enter your new password below.', style: GoogleFonts.poppins(color: const Color(0xFF9BAE9E))),
              const SizedBox(height: 32),
              if (widget.token == null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16.0),
                  child: TextField(
                    controller: _tokenController,
                    decoration: const InputDecoration(labelText: 'Reset Token', border: OutlineInputBorder()),
                  ),
                ),
              TextField(
                controller: _passwordController,
                obscureText: _obscure,
                decoration: InputDecoration(
                  labelText: 'New Password',
                  border: const OutlineInputBorder(),
                  suffixIcon: IconButton(
                    icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
              ),
              _buildPasswordCheckpoints(),
              const SizedBox(height: 16),
              TextField(
                controller: _confirmPasswordController,
                obscureText: _obscure,
                enabled: _allCheckpointsMet,
                decoration: InputDecoration(
                  labelText: 'Confirm New Password',
                  border: const OutlineInputBorder(),
                  filled: !_allCheckpointsMet,
                  fillColor: _allCheckpointsMet ? null : const Color(0xFF294C3A),
                ),
              ),
              const SizedBox(height: 32),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton(
                  onPressed: (_isLoading || !_allCheckpointsMet || _passwordController.text != _confirmPasswordController.text)
                      ? null
                      : _handleReset,
                  style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFD0CFBA), foregroundColor: const Color(0xFF294C3A)),
                  child: _isLoading ? const CircularProgressIndicator(color: Color(0xFF294C3A)) : const Text('Reset Password'),
                ),
              ),
            ],
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
}
