import 'package:flutter/material.dart';
import '../services/secure_token_store.dart';
import 'package:provider/provider.dart';
import '../components/initialization_failure.dart';
import '../components/skeletons.dart';
import '../providers/ride_provider.dart';
import '../providers/group_provider.dart';
import '../providers/session_provider.dart';
import '../providers/specials_provider.dart';
import '../services/app_nav.dart';
import '../services/auth_service.dart';
import 'map_screen.dart';
import 'specials_screen.dart';
import 'groups_screen.dart';
import 'activity_screen.dart';
import 'profile_screen.dart';

class MainWrapper extends StatefulWidget {
  const MainWrapper({super.key});

  @override
  State<MainWrapper> createState() => _MainWrapperState();
}

class _MainWrapperState extends State<MainWrapper> {
  int _selectedIndex = 0;
  bool _redirectingToLogin = false;

  // Navigation: Explore / Specials / Groups / Activity / Account.
  // Groups is a first-class destination between discovery and history.
  late final List<Widget> _screens;

  @override
  void initState() {
    super.initState();
    _screens = [
      MapScreen(onOpenSpecials: () => _onItemTapped(AppNav.specials)),
      const SpecialsScreen(),
      const GroupsScreen(),
      const ActivityScreen(),
      const ProfileScreen(),
    ];
    AppNav.instance.addListener(_onNavRequest);
    // Apply any tab request that arrived while this wrapper was off-tree
    // (e.g. a deep link or a sheet fired during a trip screen).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _onNavRequest();
        _checkAuth();
      }
    });
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
    if (!SecureTokenStore.hasToken) {
      _goToLogin();
      return;
    }
    final session = context.read<SessionProvider>();
    if (!session.isReady) {
      await session.initialize();
    }
  }

  void _goToLogin() {
    if (_redirectingToLogin) return;
    _redirectingToLogin = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
    });
  }

  Future<void> _signOut() async {
    await AuthService.logout();
    if (!mounted) return;
    Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
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
    if (index == AppNav.groups) {
      final groups = context.read<GroupProvider>();
      groups.refreshGroups(silent: true);
      groups.refreshFriends();
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionProvider>();
    final groupProvider = context.watch<GroupProvider>();
    final groupBadge = groupProvider.unreadTotal + groupProvider.incomingInvitations.length;

    if (session.status == SessionStatus.unauthenticated) {
      // The auth flow that cleared the session owns the navigation. Rendering
      // a neutral skeleton here avoids a duplicate login push during logout.
      return const Scaffold(
        body: ExploreSkeleton(),
        bottomNavigationBar: SkeletonBottomNavigation(),
      );
    }

    if (session.isBusy) {
      return const Scaffold(
        body: ExploreSkeleton(),
        bottomNavigationBar: SkeletonBottomNavigation(),
      );
    }

    if (session.status == SessionStatus.failed) {
      return InitializationFailure(
        message: session.errorMessage,
        onRetry: session.retry,
        onSignOut: _signOut,
      );
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
                BottomNavigationBarItem(
                  icon: _BadgedIcon(
                    icon: Icons.groups_2_outlined,
                    count: groupBadge,
                  ),
                  activeIcon: _BadgedIcon(
                    icon: Icons.groups_2,
                    count: groupBadge,
                  ),
                  label: 'Groups',
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

class _BadgedIcon extends StatelessWidget {
  const _BadgedIcon({required this.icon, required this.count});
  final IconData icon;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Icon(icon, size: 24),
        if (count > 0)
          Positioned(
            right: -8,
            top: -5,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
              constraints: const BoxConstraints(minWidth: 16),
              decoration: BoxDecoration(
                color: const Color(0xFFC65A5A),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: Colors.white, width: 1.5),
              ),
              child: Text(
                count > 99 ? '99+' : '$count',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 8.5,
                  fontWeight: FontWeight.w800,
                  height: 1.1,
                ),
              ),
            ),
          ),
      ],
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
