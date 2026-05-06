import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'providers/driver_provider.dart';
import 'screens/availability_screen.dart';
import 'screens/trip_screen.dart';
import 'screens/login_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/signup_screen.dart';
import 'screens/verification_screen.dart';
import 'screens/success_screen.dart';
import 'screens/profile_screen.dart';
import 'screens/reset_password_screen.dart';
import 'screens/main_wrapper.dart';
import 'screens/splash_screen.dart';
import 'services/api_service.dart';
import 'theme/app_theme.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'package:app_links/app_links.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await dotenv.load(fileName: ".env");

  await Supabase.initialize(
    url: dotenv.env['SUPABASE_URL'] ?? '',
    anonKey: dotenv.env['SUPABASE_ANON_KEY'] ?? '',
  );

  await ApiService.init();
  
  final prefs = await SharedPreferences.getInstance();
  String? token = prefs.getString('jwt_token');

  // SYNC LOGIC: If we have a Supabase session but no backend token, sync now
  final supabase = Supabase.instance.client;
  if (supabase.auth.currentSession != null && token == null) {
    debugPrint('[MAIN] 💡 Supabase session found but no backend token. Syncing...');
    final success = await AuthService.syncWithBackend();
    if (success) {
      token = prefs.getString('jwt_token');
    }
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

class _NetRideDriverState extends State<NetRideDriver> {
  late AppLinks _appLinks;

  @override
  void initState() {
    super.initState();
    _initDeepLinks();
  }

  void _initDeepLinks() {
    _appLinks = AppLinks();
    _appLinks.uriLinkStream.listen((uri) {
      debugPrint('🔗 Received Deep Link: $uri');
      if (uri.host == 'password-reset' || uri.path.contains('password-reset')) {
        final token = uri.queryParameters['token'];
        if (token != null) {
          ApiService.navigatorKey.currentState?.pushNamed('/reset-password', arguments: {'token': token});
        }
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: ApiService.navigatorKey,
      title: 'NetRide Driver',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      initialRoute: '/splash',
      onGenerateRoute: (settings) {
        Widget page;
        switch (settings.name) {
          case '/splash':
            final args = settings.arguments as Map<String, dynamic>?;
            page = SplashScreen(
              targetRoute: args?['targetRoute'] ?? (widget.isAuthenticated ? '/' : '/login'),
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
