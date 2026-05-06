import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../services/auth_service.dart';

class SettingsScreen extends StatefulWidget {
  final bool hasPassword;
  const SettingsScreen({super.key, required this.hasPassword});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  Future<void> _showChangePasswordDialog() async {
    final currentPasswordController = TextEditingController();
    bool obscure = true;

    await showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text('Security Check', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Please enter your current password to receive a verification email.', style: GoogleFonts.poppins(fontSize: 13)),
              const SizedBox(height: 16),
              TextField(
                controller: currentPasswordController,
                obscureText: obscure,
                decoration: InputDecoration(
                  labelText: 'Current Password',
                  suffixIcon: IconButton(
                    icon: Icon(obscure ? Icons.visibility_off : Icons.visibility),
                    onPressed: () => setDialogState(() => obscure = !obscure),
                  ),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                if (currentPasswordController.text.isEmpty) return;
                try {
                  await AuthService.requestPasswordChange(currentPasswordController.text);
                  if (mounted) {
                    Navigator.pop(context);
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Verification email sent! Please check your inbox.')),
                    );
                  }
                } catch (e) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              },
              style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
              child: const Text('Send Verification'),
            ),
          ],
        ),
      ),
    );
  }

  void _navigateToAccountAction(bool isDeletion) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => AccountActionScreen(isDeletion: isDeletion),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: const Color(0xFF2F3A32),
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          _buildSectionCard(
            title: 'Security',
            children: [
              _buildMenuTile(
                icon: Icons.lock_outline_rounded,
                title: 'Password & Security',
                onTap: _showChangePasswordDialog,
                enabled: widget.hasPassword,
              ),
            ],
          ),
          const SizedBox(height: 24),
          _buildSectionCard(
            title: 'Account Actions',
            children: [
              _buildMenuTile(
                icon: Icons.pause_circle_outline_rounded,
                title: 'Deactivate Account',
                onTap: () => _navigateToAccountAction(false),
              ),
              const Divider(height: 32),
              _buildMenuTile(
                icon: Icons.delete_forever_rounded,
                title: 'Delete Account',
                onTap: () => _navigateToAccountAction(true),
                textColor: const Color(0xFFC65A5A),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSectionCard({required String title, required List<Widget> children}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 12),
          child: Text(
            title,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: Color(0xFF2F3A32),
              letterSpacing: 0.5,
            ),
          ),
        ),
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: const Color(0xFFD8D2CA)),
          ),
          child: Column(
            children: children,
          ),
        ),
      ],
    );
  }

  Widget _buildMenuTile({
    required IconData icon,
    required String title,
    required VoidCallback onTap,
    bool enabled = true,
    Color? textColor,
  }) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      behavior: HitTestBehavior.opaque,
      child: Opacity(
        opacity: enabled ? 1.0 : 0.4,
        child: Row(
          children: [
            Icon(icon, size: 20, color: (textColor ?? const Color(0xFF2F3A32)).withOpacity(0.4)),
            const SizedBox(width: 16),
            Expanded(
              child: Text(
                title,
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: textColor ?? const Color(0xFF2F3A32)),
              ),
            ),
            const Icon(Icons.chevron_right_rounded, size: 20, color: Colors.grey),
          ],
        ),
      ),
    );
  }
}

class AccountActionScreen extends StatefulWidget {
  final bool isDeletion;
  const AccountActionScreen({super.key, required this.isDeletion});

  @override
  State<AccountActionScreen> createState() => _AccountActionScreenState();
}

class _AccountActionScreenState extends State<AccountActionScreen> {
  bool _understands = false;
  bool _isLoading = false;

  Future<void> _handleAction() async {
    final actionName = widget.isDeletion ? 'Delete' : 'Deactivate';
    
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('$actionName Account?', style: GoogleFonts.poppins(fontWeight: FontWeight.bold)),
        content: Text('Are you absolutely sure you want to $actionName your account?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(actionName, style: const TextStyle(color: Colors.red, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );

    if (confirm == true) {
      setState(() => _isLoading = true);
      try {
        if (widget.isDeletion) {
          await AuthService.deleteAccount();
        } else {
          await AuthService.deactivateAccount();
        }
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        }
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Action failed: $e')));
        }
      } finally {
        if (mounted) setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final actionName = widget.isDeletion ? 'Delete' : 'Deactivate';
    
    return Scaffold(
      appBar: AppBar(
        title: Text('$actionName Account'),
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: const Color(0xFF2F3A32),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              widget.isDeletion ? Icons.warning_amber_rounded : Icons.info_outline_rounded,
              size: 64,
              color: widget.isDeletion ? const Color(0xFFC65A5A) : const Color(0xFFC79A4A),
            ),
            const SizedBox(height: 24),
            Text(
              'Important Information',
              style: GoogleFonts.poppins(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 16),
            Expanded(
              child: SingleChildScrollView(
                child: Text(
                  widget.isDeletion
                      ? 'When you delete your account, all your data, including profile information, trip history, and preferences, will be permanently removed from the app. This action cannot be undone.'
                      : 'When you deactivate your account, your profile will be hidden and you won\'t be able to use the app until you sign back in. Your data will be preserved, and signing back in will immediately reactivate your account.',
                  style: GoogleFonts.poppins(fontSize: 16, color: Colors.black87, height: 1.5),
                ),
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Checkbox(
                  value: _understands,
                  onChanged: (val) => setState(() => _understands = val ?? false),
                  activeColor: const Color(0xFF5B7760),
                ),
                Expanded(
                  child: Text(
                    'I understand the consequences of ${actionName.toLowerCase()}ing my account.',
                    style: GoogleFonts.poppins(fontSize: 14),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _understands && !_isLoading ? _handleAction : null,
                style: ElevatedButton.styleFrom(
                  backgroundColor: widget.isDeletion ? const Color(0xFFC65A5A) : const Color(0xFF5B7760),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: _isLoading
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : Text(actionName, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
