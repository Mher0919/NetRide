import '../services/secure_token_store.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'availability_screen.dart';
import 'activity_screen.dart';
import 'profile_screen.dart';
import '../components/initialization_failure.dart';
import '../components/skeletons.dart';
import '../services/auth_service.dart';
import '../providers/driver_provider.dart';

class MainWrapper extends StatefulWidget {
  const MainWrapper({super.key});

  @override
  State<MainWrapper> createState() => _MainWrapperState();
}

class _MainWrapperState extends State<MainWrapper> {
  int _selectedIndex = 0;
  bool _isChecking = true;
  bool _redirecting = false;
  String? _initializationError;

  final List<Widget> _screens = [
    const AvailabilityScreen(),
    const ActivityScreen(),
    const ProfileScreen(),
  ];

  @override
  void initState() {
    super.initState();
    // Navigation must not run while the first frame is still being built;
    // schedule the auth guard once the navigator is unlocked.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _checkAuth();
    });
  }

  Future<void> _checkAuth() async {
    final token = SecureTokenStore.token;
    if (token == null || token.isEmpty) {
      _goToLogin();
      return;
    }

    final provider = context.read<DriverProvider>();
    await provider.initialize();
    if (!mounted) return;

    if (provider.initializationFailed) {
      setState(() {
        _isChecking = false;
        _initializationError = provider.initErrorMessage ??
            'We could not load your driver account. Please try again.';
      });
      return;
    }

    try {
      // The backend is the single source of truth for onboarding completion.
      // Crucially, a failed request is NOT interpreted as "onboarding
      // incomplete" — that would bounce a fully registered driver back into
      // onboarding on a transient network error.
      final status = await AuthService.getOnboardingStatus();
      if (!mounted) return;
      final driver = status['driver'];
      final complete =
          driver is Map && driver['onboarding_complete'] == true;
      if (!complete) {
        Navigator.pushNamedAndRemoveUntil(
          context,
          '/onboarding',
          (route) => false,
        );
        return;
      }

      setState(() {
        _isChecking = false;
        _initializationError = null;
      });
    } catch (e) {
      debugPrint('[MAIN] Driver onboarding check failed: $e');
      if (!mounted) return;
      setState(() {
        _isChecking = false;
        _initializationError =
            'We could not confirm your account status. Check your connection and retry.';
      });
    }
  }

  void _goToLogin() {
    if (_redirecting) return;
    _redirecting = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
    });
  }

  Future<void> _retryInitialization() async {
    final provider = context.read<DriverProvider>();
    setState(() {
      _isChecking = true;
      _initializationError = null;
    });
    await provider.initialize(forceRefresh: true);
    if (!mounted) return;
    await _checkAuth();
  }

  Future<void> _signOut() async {
    await AuthService.logout();
    if (!mounted) return;
    Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
  }

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<DriverProvider>();

    if (provider.initState == DriverInitState.failed &&
        _initializationError == null) {
      return InitializationFailure(
        message: provider.initErrorMessage,
        onRetry: _retryInitialization,
        onSignOut: _signOut,
      );
    }

    if (_initializationError != null) {
      return InitializationFailure(
        message: _initializationError,
        onRetry: _retryInitialization,
        onSignOut: _signOut,
      );
    }

    if (_isChecking || provider.initState == DriverInitState.loading) {
      return const Scaffold(
        backgroundColor: Color(0xFFEEEBE6),
        body: DriverDashboardSkeleton(),
        bottomNavigationBar: SkeletonBottomNavigation(),
      );
    }

    return Scaffold(
      body: IndexedStack(
        index: _selectedIndex,
        children: _screens,
      ),
      bottomNavigationBar: BottomNavigationBar(
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(
            icon: Icon(Icons.explore_outlined, size: 24),
            activeIcon: Icon(Icons.explore, size: 24),
            label: 'Status',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.receipt_long_outlined, size: 24),
            activeIcon: Icon(Icons.receipt_long, size: 24),
            label: 'Activity',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.person_outline_rounded, size: 24),
            activeIcon: Icon(Icons.person_rounded, size: 24),
            label: 'Account',
          ),
        ],
        currentIndex: _selectedIndex,
        selectedItemColor: const Color(0xFF5B7760),
        unselectedItemColor: const Color(0xFF2F3A32).withOpacity(0.4),
        showUnselectedLabels: true,
        type: BottomNavigationBarType.fixed,
        onTap: _onItemTapped,
      ),
    );
  }
}
