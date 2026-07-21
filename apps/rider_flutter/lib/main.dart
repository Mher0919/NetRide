import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'providers/ride_provider.dart';
import 'services/communication_service.dart';
import 'screens/map_screen.dart';
import 'screens/ride_request_screen.dart';
import 'screens/trip_screen.dart';
import 'screens/login_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/signup_screen.dart';
import 'screens/profile_screen.dart';
import 'screens/reset_password_screen.dart';
import 'screens/main_wrapper.dart';
import 'screens/splash_screen.dart';
import 'screens/blocked_account_screen.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'services/user_service.dart';
import 'services/sound_service.dart';
import 'theme/app_theme.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'package:app_links/app_links.dart';

/// Set when a signed-in rider's account is blocked, so the app routes
/// straight to the standalone blocked-account screen on startup.
bool kInitialIsBlocked = false;
String? kInitialBlockedReason;

/// Resolved at startup from the backend. The backend is the single source of
/// truth for whether onboarding (including mandatory phone verification) is
/// complete. Until it confirms completion, the app must stay in onboarding.
String kInitialTargetRoute = '/login';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await dotenv.load(fileName: ".env");
  
  await Supabase.initialize(
    url: dotenv.env['SUPABASE_URL'] ?? '',
    anonKey: dotenv.env['SUPABASE_ANON_KEY'] ?? '',
  );

  await ApiService.init();
  await SoundService.instance.init();

  final prefs = await SharedPreferences.getInstance();
  String? token = prefs.getString('jwt_token');
  
  final supabase = Supabase.instance.client;
  if (token != null && AuthService.isJwtExpired(token)) {
    debugPrint('[MAIN] ⚠️ Stored backend JWT token has expired.');
    if (supabase.auth.currentSession != null) {
      debugPrint('[MAIN] 🔄 Active Supabase session found. Attempting backend sync...');
      final success = await AuthService.syncWithBackend();
      if (success) {
        token = prefs.getString('jwt_token');
      } else {
        debugPrint('[MAIN] ❌ Sync failed. Clearing expired session...');
        await AuthService.logout();
        token = null;
      }
    } else {
      debugPrint('[MAIN] ❌ No active session. Clearing expired token...');
      await AuthService.logout();
      token = null;
    }
  } else if (token == null && supabase.auth.currentSession != null) {
    debugPrint('[MAIN] 💡 Supabase session found but no backend token. Syncing...');
    final success = await AuthService.syncWithBackend();
    if (success) {
      token = prefs.getString('jwt_token');
    }
  }

  AuthService.isAuthenticatedNotifier.value = token != null;

  if (token != null) {
    // Determine the correct startup destination from authoritative backend
    // state. Never assume onboarding is complete based on local token alone.
    try {
      final profile = await UserService.getProfile();
      if (profile['verification_status'] == 'BLOCKED') {
        kInitialBlockedReason = profile['blocked_reason'] as String?;
        kInitialIsBlocked = true;
        kInitialTargetRoute = '/blocked';
      } else if (await AuthService.isRiderOnboardingComplete()) {
        kInitialTargetRoute = '/';
      } else {
        kInitialTargetRoute = '/onboarding';
      }
    } catch (_) {
      // If the backend cannot be reached, DO NOT bypass onboarding. Keep the
      // user in the onboarding flow (or login if no token context).
      kInitialTargetRoute = '/onboarding';
    }
  } else {
    kInitialTargetRoute = '/login';
  }

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) {
          final provider = RideProvider();
          if (token != null) {
            provider.initSocket(token);
          }
          return provider;
        }),
        // Communication service is shared across the trip screens for
        // chat + masked calls. The service is attached lazily once a
        // trip is active so it doesn't burn listeners on the splash
        // screen or login flow.
        ChangeNotifierProvider(create: (_) => CommunicationService()),
      ],
      child: const NetRideRider(),
    ),
  );
}

class NetRideRider extends StatefulWidget {
  const NetRideRider({super.key});

  @override
  State<NetRideRider> createState() => _NetRideRiderState();
}

class _NetRideRiderState extends State<NetRideRider> with WidgetsBindingObserver {
  late AppLinks _appLinks;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initDeepLinks();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      debugPrint('[LIFECYCLE] Rider app returned to foreground');
      try {
        final context = ApiService.navigatorKey.currentContext;
        if (context != null) {
          final provider = Provider.of<RideProvider>(context, listen: false);
          provider.onAppForegrounded();
        }
      } catch (e) {
        debugPrint('[LIFECYCLE] Foreground callback error: $e');
      }
    }
  }

  void _initDeepLinks() {
    _appLinks = AppLinks();
    
    // Handle initial link (when app is launched via URI scheme)
    _appLinks.getInitialLink().then((uri) {
      if (uri != null) {
        debugPrint('🔗 Initial Deep Link: $uri');
        _handleDeepLink(uri);
      }
    });

    // Handle subsequent links
    _appLinks.uriLinkStream.listen((uri) {
      debugPrint('🔗 Received Deep Link: $uri');
      _handleDeepLink(uri);
    });
  }

  void _handleDeepLink(Uri uri) {
    if (uri.host == 'password-reset' || uri.path.contains('password-reset')) {
      final token = uri.queryParameters['token'];
      if (token != null) {
        ApiService.navigatorKey.currentState?.pushNamed('/reset-password', arguments: {'token': token});
      }
    }
    // Note: OAuth callback (login-callback) is handled automatically by Supabase
    // via the auth state change listener in the login screen.
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: AuthService.isAuthenticatedNotifier,
      builder: (context, isAuthenticated, child) {
        return MaterialApp(
          navigatorKey: ApiService.navigatorKey,
          title: 'NetRide Rider',
          debugShowCheckedModeBanner: false,
          theme: AppTheme.lightTheme,
          initialRoute: '/splash',
          builder: (context, child) =>
              GlobalClickSoundListener(child: child ?? const SizedBox.shrink()),
          onGenerateRoute: (settings) {
            Widget page;
            switch (settings.name) {
              case '/splash':
                final args = settings.arguments as Map<String, dynamic>?;
                final targetRoute = kInitialIsBlocked
                    ? '/blocked'
                    : (args?['targetRoute'] ?? kInitialTargetRoute);
                page = SplashScreen(
                  targetRoute: targetRoute,
                  arguments: args?['arguments'],
                );
                break;
              case '/blocked':
                page = BlockedAccountScreen(reason: kInitialBlockedReason);
                break;
              case '/login':
                page = const LoginScreen();
                break;
              case '/signup':
                page = const SignupScreen();
                break;
              case '/onboarding':
                page = const OnboardingScreen();
                break;
              case '/':
                page = const MainWrapper();
                break;
              case '/ride_request':
                page = const RideRequestScreen();
                break;
              case '/trip':
                page = const TripScreen();
                break;
              case '/profile':
                page = const ProfileScreen();
                break;
              case '/reset-password':
                final args = settings.arguments as Map<String, dynamic>?;
                page = ResetPasswordScreen(token: args?['token']);
                break;
              default:
                page = const MapScreen();
            }
            return PageRouteBuilder(
              settings: settings,
              pageBuilder: (context, animation, secondaryAnimation) => page,
              transitionsBuilder: (context, animation, secondaryAnimation, child) {
                return FadeTransition(opacity: animation, child: child);
              },
            );
          },
        );
      },
    );
  }
}
