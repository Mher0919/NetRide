import 'package:flutter/material.dart';
import 'dart:io';
import 'package:google_fonts/google_fonts.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:provider/provider.dart';
import '../providers/driver_provider.dart';
import '../services/auth_service.dart';
import 'signup_screen.dart';
import 'verification_screen.dart';

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
      final supabase = Supabase.instance.client;
      
      // 1. Listen for the FIRST session event to complete the login
      final subscription = supabase.auth.onAuthStateChange.listen((data) async {
        final session = data.session;
        if (session != null) {
          try {
            final res = await AuthService.loginWithOAuth(
              email: session.user.email!,
              fullName: session.user.userMetadata?['full_name'] ?? 'NetRide Driver',
              profileImageUrl: session.user.userMetadata?['avatar_url'],
              role: 'DRIVER',
            );
            
            if (mounted) {
              // Initialize socket with the backend token
              Provider.of<DriverProvider>(context, listen: false).initSocket(res['token']);

              Navigator.pushReplacementNamed(context, '/splash', arguments: {'targetRoute': '/onboarding'});
            }
          } catch (e) {
            debugPrint('Error during backend OAuth sync: $e');
          }
        }
      });

      // 2. Trigger the OAuth flow
      await supabase.auth.signInWithOAuth(
        provider == 'google' ? OAuthProvider.google : OAuthProvider.apple,
        redirectTo: 'io.supabase.netride://login-callback/',
      );

      // Clean up subscription after a timeout if no session is received
      Future.delayed(const Duration(minutes: 5), () => subscription.cancel());

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
      final res = await AuthService.loginWithPassword(
        email: _emailController.text.trim(),
        password: _passwordController.text.trim(),
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
          final hasPhone = res['user']['phone_number'] != null && res['user']['phone_number'].toString().isNotEmpty;
          Navigator.pushReplacementNamed(
            context, 
            '/splash', 
            arguments: {'targetRoute': hasPhone ? '/' : '/'}
          );
        }
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
    final theme = Theme.of(context);
    
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                const SizedBox(height: 60),
                Text(
                  'NetRide Driver',
                  style: theme.textTheme.displayLarge?.copyWith(
                    fontSize: 40,
                    letterSpacing: -2,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Premium service partner',
                  style: theme.textTheme.bodyLarge?.copyWith(
                    color: theme.colorScheme.onSurface.withOpacity(0.6),
                    letterSpacing: 0.5,
                  ),
                ),
                const SizedBox(height: 40),
                Center(
                  child: Hero(
                    tag: 'auth_icon',
                    child: Container(
                      width: 260,
                      height: 260,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.white.withOpacity(0.5),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withOpacity(0.05),
                            blurRadius: 30,
                            offset: const Offset(0, 10),
                          ),
                        ],
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(40.0),
                        child: Image.asset(
                          'assets/images/logo-noBackground.png',
                          fit: BoxFit.contain,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 60),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 400),
                  child: _isLoading 
                    ? const Center(child: CircularProgressIndicator())
                    : _showEmailField 
                      ? Column(
                          key: const ValueKey('email_flow'),
                          children: [
                            TextField(
                              controller: _emailController,
                              keyboardType: TextInputType.emailAddress,
                              decoration: const InputDecoration(
                                hintText: 'Email address',
                                prefixIcon: Icon(Icons.email_outlined, size: 20),
                              ),
                            ),
                            const SizedBox(height: 16),
                            TextField(
                              controller: _passwordController,
                              obscureText: _obscurePassword,
                              decoration: InputDecoration(
                                hintText: 'Password',
                                prefixIcon: const Icon(Icons.lock_outline_rounded, size: 20),
                                suffixIcon: IconButton(
                                  icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility, size: 20, color: Colors.grey),
                                  onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                                ),
                              ),
                            ),
                            Align(
                              alignment: Alignment.centerRight,
                              child: TextButton(
                                onPressed: _handleForgotPassword,
                                child: Text('Forgot Password?', style: TextStyle(color: theme.colorScheme.primary, fontSize: 13, fontWeight: FontWeight.w500)),
                              ),
                            ),
                            const SizedBox(height: 8),
                            SizedBox(
                              width: double.infinity,
                              child: ElevatedButton(
                                onPressed: _handleEmailLogin,
                                child: const Text('Login'),
                              ),
                            ),
                            const SizedBox(height: 12),
                            TextButton(
                              onPressed: () => setState(() => _showEmailField = false),
                              child: Text('Back to other options', style: TextStyle(color: theme.colorScheme.onSurface.withOpacity(0.5))),
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
                              backgroundColor: Colors.white,
                              textColor: theme.colorScheme.onSurface,
                              hasBorder: true,
                            ),
                            const SizedBox(height: 12),
                            _OAuthButton(
                              icon: Icons.apple_rounded,
                              label: 'Continue with Apple',
                              onPressed: () => _handleOAuth('apple'),
                              backgroundColor: theme.colorScheme.onSurface,
                              textColor: Colors.white,
                            ),
                            const SizedBox(height: 12),
                            _OAuthButton(
                              icon: Icons.email_rounded,
                              label: 'Continue with Email',
                              onPressed: () => setState(() => _showEmailField = true),
                              backgroundColor: Colors.transparent,
                              textColor: theme.colorScheme.onSurface,
                              hasBorder: true,
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
                          Text("Don't have an account? ", style: TextStyle(color: theme.colorScheme.onSurface.withOpacity(0.6))),
                          GestureDetector(
                            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (context) => const SignupScreen())),
                            child: Text("Sign Up", style: TextStyle(color: theme.colorScheme.primary, fontWeight: FontWeight.bold)),
                          ),
                        ],
                      ),
                      const SizedBox(height: 32),
                      Text(
                        'By continuing, you agree to our Terms and Privacy Policy',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurface.withOpacity(0.4)),
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
  final Color backgroundColor;
  final Color textColor;
  final bool hasBorder;

  const _OAuthButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    required this.backgroundColor,
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
          backgroundColor: backgroundColor,
          foregroundColor: textColor,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: hasBorder ? BorderSide(color: Theme.of(context).dividerColor) : BorderSide.none,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 24),
            const SizedBox(width: 12),
            Text(
              label,
              style: const TextStyle(
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
