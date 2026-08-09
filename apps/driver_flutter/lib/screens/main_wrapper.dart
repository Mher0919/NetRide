import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'availability_screen.dart';
import 'activity_screen.dart';
import 'profile_screen.dart';
import '../services/user_service.dart';
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

  final List<Widget> _screens = [
    const AvailabilityScreen(),
    const ActivityScreen(),
    const ProfileScreen(),
  ];

  @override
  void initState() {
    super.initState();
    _checkAuth();
  }

  Future<void> _checkAuth() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('jwt_token');
    if (token == null) {
      if (mounted) {
        Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
      }
      return;
    }

    try {
      // The backend is the single source of truth for onboarding completion.
      // Even if this screen is reached via a deep link, back-stack, or a stale
      // local cache, an un-onboarded driver must be sent back to onboarding.
      final complete = await AuthService.isDriverOnboardingComplete();
      if (!complete) {
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/onboarding', (route) => false);
        }
        return;
      }

      // Warm the cache for downstream screens, but do NOT use it for the
      // onboarding decision above.
      try {
        final provider = Provider.of<DriverProvider>(context, listen: false);
        unawaited(provider.fetchProfile());
      } catch (_) {
        // Non-fatal; the guard decision is already made from the backend.
      }

      if (mounted) {
        setState(() => _isChecking = false);
      }
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 404) {
        debugPrint('User not found (404), logging out...');
        await AuthService.logout();
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        }
        return;
      }
      if (mounted) {
        setState(() => _isChecking = false);
      }
    }
  }

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_isChecking) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
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
        selectedItemColor: const Color(0xFFD0CFBA),
        unselectedItemColor: const Color(0xFFD0CFBA).withOpacity(0.4),
        showUnselectedLabels: true,
        type: BottomNavigationBarType.fixed,
        onTap: _onItemTapped,
      ),
    );
  }
}
