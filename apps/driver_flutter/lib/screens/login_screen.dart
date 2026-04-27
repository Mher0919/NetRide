import 'package:flutter/material.dart';
import 'dart:io';
import 'package:google_fonts/google_fonts.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import '../services/auth_service.dart';
import 'signup_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _isLoading = false;
  bool _showEmailField = false;
  bool _obscurePassword = true;
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();

  Future<void> _handleOAuth(String provider) async {
    setState(() => _isLoading = true);
    try {
      if (provider == 'google') {
        final googleSignIn = GoogleSignIn(
          clientId: Platform.isIOS ? dotenv.env['GOOGLE_CLIENT_ID_IOS'] : null,
          serverClientId: dotenv.env['GOOGLE_CLIENT_ID_WEB'],
        );
        final user = await googleSignIn.signIn();
        if (user != null) {
          await AuthService.loginWithOAuth(
            email: user.email,
            fullName: user.displayName ?? 'Uberish Driver',
            profileImageUrl: user.photoUrl,
            role: 'DRIVER',
          );
          if (mounted) Navigator.pushReplacementNamed(context, '/onboarding');
        }
      } else if (provider == 'apple') {
        final credential = await SignInWithApple.getAppleIDCredential(
          scopes: [
            AppleIDAuthorizationScopes.email,
            AppleIDAuthorizationScopes.fullName,
          ],
        );
        
        await AuthService.loginWithOAuth(
          email: credential.email ?? '',
          fullName: '${credential.givenName ?? ''} ${credential.familyName ?? ''}'.trim().isEmpty 
            ? 'Uberish Driver' 
            : '${credential.givenName ?? ''} ${credential.familyName ?? ''}'.trim(),
          role: 'DRIVER',
        );
        if (mounted) Navigator.pushReplacementNamed(context, '/onboarding');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Login failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _handleEmailLogin() async {
    if (_emailController.text.isEmpty || !_emailController.text.contains('@')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a valid email')),
      );
      return;
    }
    if (_passwordController.text.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter your password')),
      );
      return;
    }

    setState(() => _isLoading = true);
    try {
      await AuthService.loginWithPassword(
        email: _emailController.text.trim(),
        password: _passwordController.text.trim(),
      );
      if (mounted) {
        Navigator.pushReplacementNamed(context, '/');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _handleForgotPassword() async {
    if (_emailController.text.isEmpty || !_emailController.text.contains('@')) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter your email to receive a reset link')),
      );
      return;
    }

    setState(() => _isLoading = true);
    try {
      await AuthService.forgotPassword(_emailController.text.trim());
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Reset link sent to your email')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 60),
                Text(
                  'Uberish Driver',
                  style: GoogleFonts.poppins(
                    fontSize: 32,
                    fontWeight: FontWeight.bold,
                    letterSpacing: -1,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Welcome back, partner',
                  style: GoogleFonts.poppins(
                    fontSize: 18,
                    color: Colors.grey[600],
                  ),
                ),
                const SizedBox(height: 40),
                Center(
                  child: Hero(
                    tag: 'auth_icon',
                    child: Container(
                      width: 160,
                      height: 160,
                      decoration: BoxDecoration(
                        color: Colors.blue[50],
                        shape: BoxShape.circle,
                      ),
                      child: Icon(Icons.drive_eta_rounded, size: 70, color: Colors.blue[700]),
                    ),
                  ),
                ),
                const SizedBox(height: 60),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 400),
                  child: _isLoading 
                    ? const Center(child: CircularProgressIndicator(color: Colors.black))
                    : _showEmailField 
                      ? Column(
                          key: const ValueKey('email_flow'),
                          children: [
                            TextField(
                              controller: _emailController,
                              keyboardType: TextInputType.emailAddress,
                              style: GoogleFonts.poppins(),
                              decoration: InputDecoration(
                                hintText: 'Enter your email',
                                prefixIcon: const Icon(Icons.email_outlined),
                                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                                focusedBorder: OutlineInputBorder(
                                  borderRadius: BorderRadius.circular(12),
                                  borderSide: const BorderSide(color: Colors.black, width: 2),
                                ),
                              ),
                            ),
                            const SizedBox(height: 16),
                            TextField(
                              controller: _passwordController,
                              obscureText: _obscurePassword,
                              style: GoogleFonts.poppins(),
                              decoration: InputDecoration(
                                hintText: 'Enter your password',
                                prefixIcon: const Icon(Icons.lock_outline_rounded),
                                suffixIcon: IconButton(
                                  icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility, color: Colors.grey),
                                  onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                                ),
                                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                                focusedBorder: OutlineInputBorder(
                                  borderRadius: BorderRadius.circular(12),
                                  borderSide: const BorderSide(color: Colors.black, width: 2),
                                ),
                              ),
                            ),
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: _handleForgotPassword,
                                child: Text('Forgot Password?', style: GoogleFonts.poppins(color: Colors.blue[700], fontSize: 13)),
                              ),
                            ),
                            const SizedBox(height: 8),
                            SizedBox(
                              width: double.infinity,
                              height: 56,
                              child: ElevatedButton(
                                onPressed: _handleEmailLogin,
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: Colors.black,
                                  foregroundColor: Colors.white,
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                ),
                                child: Text('Login', style: GoogleFonts.poppins(fontSize: 16, fontWeight: FontWeight.w600)),
                              ),
                            ),
                            TextButton(
                              onPressed: () => setState(() => _showEmailField = false),
                              child: Text('Other options', style: GoogleFonts.poppins(color: Colors.grey[600])),
                            ),
                          ],
                        )
                      : Column(
                          key: const ValueKey('oauth_flow'),
                          children: [
                            _OAuthButton(
                              icon: Icons.g_mobiledata_rounded,
                              label: 'Continue with Google',
                              onPressed: () => _handleOAuth('google'),
                              color: Colors.white,
                              textColor: Colors.black,
                              hasBorder: true,
                            ),
                            const SizedBox(height: 12),
                            _OAuthButton(
                              icon: Icons.apple_rounded,
                              label: 'Continue with Apple',
                              onPressed: () => _handleOAuth('apple'),
                              color: Colors.black,
                              textColor: Colors.white,
                            ),
                            const SizedBox(height: 12),
                            _OAuthButton(
                              icon: Icons.email_rounded,
                              label: 'Continue with Email',
                              onPressed: () => setState(() => _showEmailField = true),
                              color: Colors.grey[100]!,
                              textColor: Colors.black,
                            ),
                          ],
                        ),
                ),
                const SizedBox(height: 40),
                Center(
                  child: Column(
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text("Don't have an account? ", style: GoogleFonts.poppins(color: Colors.grey[600])),
                          GestureDetector(
                            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (context) => const SignupScreen())),
                            child: Text("Sign Up", style: GoogleFonts.poppins(color: Colors.blue[700], fontWeight: FontWeight.bold)),
                          ),
                        ],
                      ),
                      const SizedBox(height: 20),
                      Text(
                        'By continuing, you agree to our Terms and Privacy Policy',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12, color: Colors.grey[500]),
                      ),
                    ],
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
}

class _OAuthButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final Color color;
  final Color textColor;
  final bool hasBorder;

  const _OAuthButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    required this.color,
    required this.textColor,
    this.hasBorder = false,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 56,
      child: ElevatedButton(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: color,
          foregroundColor: textColor,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: hasBorder ? BorderSide(color: Colors.grey[300]!) : BorderSide.none,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 28),
            const SizedBox(width: 12),
            Text(
              label,
              style: GoogleFonts.poppins(
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
