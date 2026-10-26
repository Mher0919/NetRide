import 'package:flutter/material.dart';
import '../services/secure_token_store.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../providers/specials_provider.dart';
import '../services/app_nav.dart';
import 'map_screen.dart';
import 'specials_screen.dart';
import 'activity_screen.dart';
import 'profile_screen.dart';

class MainWrapper extends StatefulWidget {
  const MainWrapper({super.key});

  @override
  State<MainWrapper> createState() => _MainWrapperState();
}

class _MainWrapperState extends State<MainWrapper> {
  int _selectedIndex = 0;
  bool _isChecking = true;

  // Navigation stays: Explore / Specials / Activity / Account. Specials is
  // the dedicated discovery page; Explore keeps its inline SPECIALS section.
  late final List<Widget> _screens;

  @override
  void initState() {
    super.initState();
    _screens = [
      MapScreen(onOpenSpecials: () => _onItemTapped(AppNav.specials)),
      const SpecialsScreen(),
      const ActivityScreen(),
      const ProfileScreen(),
    ];
    AppNav.instance.addListener(_onNavRequest);
    // Apply any tab request that arrived while this wrapper was off-tree
    // (e.g. a deep link or a sheet fired during a trip screen).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _onNavRequest();
    });
    _checkAuth();
  }

  @override
  void dispose() {
    AppNav.instance.removeListener(_onNavRequest);
    super.dispose();
  }

  /// Surfaces elsewhere in the app (Explore SPECIALS header, the Special
  /// business sheet) ask to switch tabs through AppNav.
  void _onNavRequest() {
    final tab = AppNav.instance.take();
    if (tab == null || !mounted) return;
    _onItemTapped(tab);
  }

  Future<void> _checkAuth() async {
    final token = SecureTokenStore.token;
    if (token == null) {
      if (mounted) {
        Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
      }
      return;
    }

    if (mounted) {
      setState(() => _isChecking = false);
    }
  }

  void _onItemTapped(int index) {
    if (mounted) {
      setState(() {
        _selectedIndex = index;
      });
    }
    // Returning to Explore or opening Specials re-queries the backend for
    // currently active specials. During a session the admin may deactivate/
    // reactivate sponsors — both surfaces must reflect the backend's
    // decision each time the rider looks at them.
    if (index == 0 || index == 1) {
      context.read<SpecialsProvider>().refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isChecking) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      // The connection banner lives above the IndexedStack so the bottom nav
      // and the active screen are unchanged. Using Consumer<RideProvider>
      // (not context.watch) keeps rebuilds local to this widget.
      body: Consumer<RideProvider>(
        builder: (context, ride, _) {
          return Column(
            children: [
              _ConnectionBanner(connected: ride.isConnected),
              Expanded(
                child: IndexedStack(index: _selectedIndex, children: _screens),
              ),
            ],
          );
        },
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.04),
              blurRadius: 20,
              offset: const Offset(0, -10),
            ),
          ],
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: BottomNavigationBar(
              items: <BottomNavigationBarItem>[
                const BottomNavigationBarItem(
                  icon: Icon(Icons.explore_outlined, size: 24),
                  activeIcon: Icon(Icons.explore, size: 24),
                  label: 'Explore',
                ),
                const BottomNavigationBarItem(
                  icon: Icon(Icons.local_offer_outlined, size: 24),
                  activeIcon: Icon(Icons.local_offer, size: 24),
                  label: 'Specials',
                ),
                const BottomNavigationBarItem(
                  icon: Icon(Icons.receipt_long_outlined, size: 24),
                  activeIcon: Icon(Icons.receipt_long, size: 24),
                  label: 'Activity',
                ),
                const BottomNavigationBarItem(
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
              elevation: 0,
              backgroundColor: Colors.transparent,
              selectedLabelStyle: const TextStyle(
                fontWeight: FontWeight.w600,
                fontSize: 12,
                letterSpacing: 0.2,
              ),
              unselectedLabelStyle: const TextStyle(
                fontWeight: FontWeight.w500,
                fontSize: 12,
                letterSpacing: 0.2,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Slim status pill that surfaces socket-connection state. Hidden when
/// connected (positive state), shown otherwise so the rider knows their app
/// is offline before they request a ride that will silently fail.
class _ConnectionBanner extends StatelessWidget {
  const _ConnectionBanner({required this.connected});

  final bool connected;

  @override
  Widget build(BuildContext context) {
    if (connected) return const SizedBox.shrink();
    return Container(
      color: const Color(0xFFB5524A),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: const [
              Icon(Icons.cloud_off_rounded, color: Colors.white, size: 18),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Reconnecting to ride service… ride requests may not send.',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
