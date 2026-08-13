import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'providers/driver_provider.dart';
import 'services/communication_service.dart';
import 'screens/availability_screen.dart';
import 'screens/trip_screen.dart';
import 'screens/login_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/signup_screen.dart';
import 'screens/verification_screen.dart';
import 'screens/success_screen.dart';
import 'screens/profile_screen.dart';
import 'screens/document_resubmission_screen.dart';
import 'screens/replace_vehicle_screen.dart';
import 'screens/vehicle_inspection_screen.dart';
import 'screens/reset_password_screen.dart';
import 'screens/main_wrapper.dart';
import 'screens/splash_screen.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'services/sound_service.dart';
import 'services/navigation_voice_service.dart';
import 'services/notification_service.dart';
import 'theme/app_theme.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'cache/cache_service.dart';

import 'package:app_links/app_links.dart';

import 'services/navigation_service.dart';

/// Resolved at startup from the backend. The backend is the single source of
/// truth for whether Driver onboarding (including mandatory phone verification)
/// is complete. Until it confirms completion, the app must stay in onboarding.
String kInitialTargetRoute = '/login';

/// Notification taps carry a backend-assigned route. The driver currently
/// receives ride-cancelled pushes only (route '/') — those land on the
/// dashboard, so no navigation is needed. '/trip' is handled for future
/// ride-scoped pushes.
void _routeFromNotification(Map<String, String> data) {
  final nav = ApiService.navigatorKey.currentState;
  if (nav == null) return;
  final route = data['route'];
  if (route == '/trip') nav.pushNamed('/trip');
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await dotenv.load(fileName: ".env");

  await Supabase.initialize(
    url: dotenv.env['SUPABASE_URL'] ?? '',
    anonKey: dotenv.env['SUPABASE_ANON_KEY'] ?? '',
  );

  await ApiService.init();
  await SoundService.instance.init();
  await NavigationVoiceService.instance.init();

  // Push notifications: boot FCM (optional — degrades gracefully when no
  // google-services.json is present) and configure tap navigation.
  await NotificationService.instance.init(onTap: _routeFromNotification);

  final prefs = await SharedPreferences.getInstance();

  // Initialize the cache layer
  await CacheService.instance.init(prefs);

  String? token = prefs.getString('jwt_token');

  final supabase = Supabase.instance.client;
  if (token != null && AuthService.isJwtExpired(token)) {
    debugPrint('[MAIN] ⚠️ Stored backend JWT token has expired.');
    // On hot restart, Supabase in-memory session state may have been wiped
    // but the persisted refresh token survives. Try refreshSession() which
    // reads from local persistence and refreshes the tokens.
    debugPrint('[MAIN] 🔄 Attempting Supabase session refresh from disk...');
    try {
      final refreshRes = await supabase.auth.refreshSession();
      if (refreshRes.session != null) {
        debugPrint('[MAIN] ✅ Session refreshed. Syncing with backend...');
        final success = await AuthService.syncWithBackend();
        if (success) {
          token = prefs.getString('jwt_token');
        } else {
          debugPrint('[MAIN] ❌ Sync failed after refresh. Clearing...');
          await AuthService.logout();
          token = null;
        }
      } else {
        debugPrint('[MAIN] ❌ No refreshable session. Clearing expired token...');
        await AuthService.logout();
        token = null;
      }
    } catch (e) {
      debugPrint('[MAIN] ❌ Session refresh failed: $e. Clearing...');
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

  if (token != null) {
    // Determine the correct startup destination from authoritative backend
    // state. Never assume onboarding is complete based on a local token alone.
    try {
      if (await AuthService.isDriverOnboardingComplete()) {
        kInitialTargetRoute = '/';
      } else {
        kInitialTargetRoute = '/onboarding';
      }
    } catch (_) {
      // Backend unreachable — but we have a valid JWT. The user already
      // completed onboarding previously; don't force them through it again.
      debugPrint('[MAIN] ⚠️ Backend unreachable. Trusting existing session.');
      kInitialTargetRoute = '/';
    }
  } else {
    kInitialTargetRoute = '/login';
  }

  // Register this device (FCM token) with the backend so pushes reach this
  // phone. Safe on every cold start — the server upserts per token.
  if (token != null) {
    await NotificationService.instance.registerDevice();
  }

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) {
          final provider = DriverProvider();
          if (token != null) {
            provider.initSocket(token);
          }
          return provider;
        }),
        ChangeNotifierProvider(create: (_) => NavigationService()),
        ChangeNotifierProvider(create: (_) => CommunicationService()),
      ],
      child: NetRideDriver(isAuthenticated: token != null),
    ),
  );
}

class NetRideDriver extends StatefulWidget {
  final bool isAuthenticated;
  const NetRideDriver({super.key, required this.isAuthenticated});

  @override
  State<NetRideDriver> createState() => _NetRideDriverState();
}

class _NetRideDriverState extends State<NetRideDriver> with WidgetsBindingObserver {
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
      debugPrint('[LIFECYCLE] App returned to foreground — triggering revalidation');
      try {
        final context = ApiService.navigatorKey.currentContext;
        if (context != null) {
          final provider = Provider.of<DriverProvider>(context, listen: false);
          provider.onAppForegrounded();
        }
      } catch (e) {
        debugPrint('[LIFECYCLE] Foreground revalidation error: $e');
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
    return MaterialApp(
      navigatorKey: ApiService.navigatorKey,
      title: 'NetRide Driver',
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
            page = SplashScreen(
              targetRoute: args?['targetRoute'] ?? kInitialTargetRoute,
              arguments: args?['arguments'],
            );
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
          case '/success':
            page = const SuccessScreen();
            break;
          case '/':
            page = const MainWrapper();
            break;
          case '/trip':
            page = const TripScreen();
            break;
          case '/profile':
            page = const ProfileScreen();
            break;
          case '/documents':
            page = const DocumentResubmissionScreen();
            break;
          case '/replace-vehicle':
            page = const ReplaceVehicleScreen();
            break;
          case '/vehicle-inspection':
            page = const VehicleInspectionScreen();
            break;
          case '/reset-password':
            final args = settings.arguments as Map<String, dynamic>?;
            page = ResetPasswordScreen(token: args?['token']);
            break;
          default:
            page = const AvailabilityScreen();
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
  }
}
