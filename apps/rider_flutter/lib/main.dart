import 'dart:async';
import 'services/secure_token_store.dart';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'providers/ride_provider.dart';
import 'providers/session_provider.dart';
import 'providers/specials_provider.dart';
import 'providers/group_provider.dart';
import 'screens/group_join_screen.dart';
import 'services/communication_service.dart';
import 'screens/map_screen.dart';
import 'screens/trip_screen.dart';
import 'screens/login_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/signup_screen.dart';
import 'screens/profile_screen.dart';
import 'screens/reset_password_screen.dart';
import 'screens/main_wrapper.dart';
import 'screens/splash_screen.dart';
import 'screens/blocked_account_screen.dart';
import 'screens/post_auth_gate.dart';
import 'screens/referral_onboarding_screen.dart';
import 'screens/referral_screen.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'services/user_service.dart';
import 'services/sound_service.dart';
import 'services/notification_service.dart';
import 'components/app_update_gate.dart';
import 'screens/credits_screen.dart';
import 'screens/special_redemption_screen.dart';
import 'theme/app_theme.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'package:app_links/app_links.dart';
import 'package:flutter_stripe/flutter_stripe.dart';
import 'services/payments_service.dart';

/// Stripe PaymentSheet bootstrap: the publishable key is fetched from the
/// backend (never hard-coded in the app) and Stripe's SDK is initialized
/// once. Card details are only ever collected inside Stripe's PaymentSheet.
Future<void> _initStripe() async {
  try {
    final config = await PaymentsService.getConfig();
    final publishableKey = config['publishableKey'] as String?;
    if (publishableKey != null && publishableKey.isNotEmpty) {
      Stripe.publishableKey = publishableKey;
      await Stripe.instance.applySettings();
      debugPrint('[STRIPE] ✅ PaymentSheet initialized (${config['mode']})');
    }
  } catch (e) {
    debugPrint('[STRIPE] ⚠️ Stripe init skipped (not configured / offline): $e');
  }
}

/// Set when a signed-in rider's account is blocked, so the app routes
/// straight to the standalone blocked-account screen on startup.
bool kInitialIsBlocked = false;
String? kInitialBlockedReason;

/// A tap that arrived before the navigator existed (cold start from a
/// notification while the app was killed). Flushed after the first frame.
NetRideNotification? _pendingNotificationTap;

/// Notification taps arrive with a backend-assigned route
/// ('/trip' | '/credits' | '/'). Navigate with the global navigator so
/// this works from any screen, foreground or after a killed-process tap.
void _routeFromNotification(NetRideNotification notification) {
  final nav = ApiService.navigatorKey.currentState;
  if (nav == null) {
    // getInitialMessage() can resolve before runApp() has built MaterialApp;
    // defer instead of dropping the tap.
    _pendingNotificationTap = notification;
    return;
  }
  // SPECIALS: the "your code is ready" push hops straight to the redemption
  // card with the one-time code carried in the push payload (delivered only
  // to this rider; never stored, spec §99).
  if (notification.type == 'special_reward_ready') {
    nav.pushNamed('/special-redemption',
        arguments: {
          'code': notification.data['code'],
          'redemptionId': notification.data['redemptionId'],
        });
    return;
  }
  switch (notification.route) {
    case '/trip':
      nav.pushNamed('/trip');
      break;
    case '/credits':
      nav.pushNamed('/credits');
      break;
    case '/groups':
      final invitationTap = notification.type == 'group_invitation' ||
          notification.type == 'friend_request' ||
          notification.type == 'friend_accepted' ||
          notification.data['invitationId'] != null;
      nav.pushNamed('/groups', arguments: {
        if (!invitationTap) 'groupId': notification.data['groupId'],
      });
      break;
    default:
      break;
  }
}

void _flushPendingNotificationTap([int attempt = 0]) {
  final pending = _pendingNotificationTap;
  if (pending == null) return;
  if (ApiService.navigatorKey.currentState == null) {
    if (attempt < 20) {
      Future<void>.delayed(
        const Duration(milliseconds: 100),
        () => _flushPendingNotificationTap(attempt + 1),
      );
    }
    return;
  }
  _pendingNotificationTap = null;
  _routeFromNotification(pending);
}

/// Resolved at startup from the backend. The backend is the single source of
/// truth for whether onboarding (including mandatory phone verification) is
/// complete. Until it confirms completion, the app must stay in onboarding.
String kInitialTargetRoute = '/login';

void main() {
  runZonedGuarded(
    _bootstrap,
    (error, stack) {
      debugPrint('[FATAL] Uncaught async error: $error');
      debugPrint('[FATAL] Stack: $stack');
    },
  );
}

/// Runs inside the same guarded zone that owns the Flutter binding, so
/// zone-local configuration and [runApp] always agree.
Future<void> _bootstrap() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Production error boundary — never show stack traces to users.
  FlutterError.onError = (details) {
    debugPrint('[FATAL] FlutterError: ${details.exception}');
    debugPrint('[FATAL] Stack: ${details.stack}');
  };
  ui.PlatformDispatcher.instance.onError = (error, stack) {
    debugPrint('[FATAL] PlatformDispatcher error: $error');
    return true;
  };

  await dotenv.load(fileName: ".env");
  
  await Supabase.initialize(
    url: dotenv.env['SUPABASE_URL'] ?? '',
    anonKey: dotenv.env['SUPABASE_ANON_KEY'] ?? '',
  );

  await ApiService.init();
  await SoundService.instance.init();

  // Push notifications: boot FCM (optional — degrades gracefully when no
  // google-services.json is present) and configure where a tapped
  // notification navigates.
  await NotificationService.instance.init(onTap: _routeFromNotification);

  // Hydrate credentials from platform secure storage (Android Keystore /
  // iOS Keychain) and migrate any legacy plaintext SharedPreferences token.
  await SecureTokenStore.init();

  String? token = SecureTokenStore.token;
  
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
          token = SecureTokenStore.token;
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
      token = SecureTokenStore.token;
    }
  }

  AuthService.isAuthenticatedNotifier.value = token != null;

  // Register this device (FCM token) with the backend so pushes reach this
  // phone. Safe to call on every cold start — server upserts per token.
  if (token != null) {
    await NotificationService.instance.registerDevice();
    await _initStripe();
  }

  if (token != null) {
    // Determine the correct startup destination from authoritative backend
    // state. Never assume onboarding is complete based on local token alone.
    // '/post-auth' re-checks (blocked status + referral eligibility) with the
    // backend right after the splash animation.
    try {
      final profile = await UserService.getProfile();
      if (profile['verification_status'] == 'BLOCKED') {
        kInitialBlockedReason = profile['blocked_reason'] as String?;
        kInitialIsBlocked = true;
        kInitialTargetRoute = '/blocked';
      } else {
        kInitialTargetRoute = '/post-auth';
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

  runApp(
    MultiProvider(
      providers: [
        // Authoritative session/profile initialization gate. Constructed after
        // the stored token has been restored, so it immediately resolves the
        // authenticated profile before any authenticated screen is rendered.
        ChangeNotifierProvider(create: (_) => SessionProvider()),
        ChangeNotifierProvider(create: (_) {
          final provider = RideProvider();
          if (token != null) {
            provider.initSocket(token);
            // Socket-independent recovery: adopt an authoritative active
            // ride over REST even if the WebSocket never connects.
            provider.hydrateFromServer();
          }
          return provider;
        }),
        // Communication service is shared across the trip screens for
        // chat + masked calls. The service is attached lazily once a
        // trip is active so it doesn't burn listeners on the splash
        // screen or login flow.
        ChangeNotifierProvider(create: (_) => CommunicationService()),
        // SPECIALS state. It subscribes to RideProvider's socket relay
        // so live redemption transitions re-render without polling.
        ChangeNotifierProvider(
          create: (ctx) =>
              SpecialsProvider(ride: ctx.read<RideProvider>()),
        ),
        // Group rides + friends. Also relays through the same socket.
        ChangeNotifierProvider(
          create: (ctx) => GroupProvider(ride: ctx.read<RideProvider>()),
        ),
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
  String? _pendingGroupToken;
  String? _pendingReferralCode;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    AuthService.isAuthenticatedNotifier.addListener(_onAuthChanged);
    _initDeepLinks();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _flushPendingNotificationTap(),
    );
  }

  @override
  void dispose() {
    AuthService.isAuthenticatedNotifier.removeListener(_onAuthChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// A fresh sign-in (OAuth, password, signup, OTP) flips the shared auth
  /// notifier. The app-level socket was created before login with no token,
  /// so it must be rebuilt here — otherwise every rider mutation emitted
  /// through a null/dead socket was silently dropped.
  Future<void> _onAuthChanged() async {
    if (AuthService.isAuthenticatedNotifier.value != true) {
      // Logout / session expiry: drop every user-scoped in-memory value so a
      // subsequent registration can never inherit the previous rider's ride
      // or specials state (the restart-only-looking failure).
      try {
        context.read<RideProvider>().reset();
        context.read<SpecialsProvider>().reset();
        context.read<GroupProvider>().reset();
      } catch (e) {
        debugPrint('[AUTH] Session cleanup failed: $e');
      }
      return;
    }
    try {
      final token = SecureTokenStore.token;
      if (token == null || token.isEmpty) return;
      final provider = context.read<RideProvider>();
      // A new authenticated identity must start from a clean ride/specials
      // snapshot; the authoritative hydration below repopulates it.
      provider.reset();
      context.read<SpecialsProvider>().reset();
      final groups = context.read<GroupProvider>();
      groups.reset();
      provider.updateToken(token);
      // Same recovery guarantee as cold start: adopt an active ride at once.
      provider.hydrateFromServer();
      groups.refreshGroups(silent: true);
      groups.refreshFriends();
      final pendingToken = _pendingGroupToken;
      if (pendingToken != null && pendingToken.isNotEmpty) {
        _pendingGroupToken = null;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            ApiService.navigatorKey.currentState
                ?.pushNamed('/group/join', arguments: {'token': pendingToken});
          }
        });
      }
      final pendingReferral = _pendingReferralCode;
      if (pendingReferral != null && pendingReferral.isNotEmpty) {
        _pendingReferralCode = null;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            ApiService.navigatorKey.currentState
                ?.pushNamed('/referral', arguments: {'code': pendingReferral});
          }
        });
      }
      await NotificationService.instance.registerDevice();
      await _initStripe();
    } catch (e) {
      debugPrint('[AUTH] Post-login socket init failed: $e');
    }
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
          final groups = Provider.of<GroupProvider>(context, listen: false);
          groups.refreshGroups(silent: true);
          if (groups.currentGroupId != null) {
            groups.refreshCurrent(silent: true);
          }
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
    // Group invitation links:
    //   netride://group/join?token=...
    //   https://<host>/join/group/<token>
    final isGroupScheme = uri.scheme == 'netride' && uri.host == 'group' && uri.path.startsWith('/join');
    final pathParts = uri.pathSegments;
    final isGroupUniversal = pathParts.length >= 3 &&
        pathParts[0] == 'join' &&
        pathParts[1] == 'group';
    if (isGroupScheme || isGroupUniversal) {
      final token = uri.queryParameters['token'] ??
          (isGroupUniversal ? pathParts[2] : null);
      if (token != null && token.isNotEmpty) {
        if (SecureTokenStore.hasToken) {
          ApiService.navigatorKey.currentState
              ?.pushNamed('/group/join', arguments: {'token': token});
        } else {
          // Signed out (fresh install): keep the token and open it right
          // after the rider authenticates.
          _pendingGroupToken = token;
        }
      }
    }

    // Referral links:
    //   netride://referral?code=ABCDEFGHIJ
    //   https://<host>/r/<CODE>
    final isReferralScheme = uri.scheme == 'netride' && uri.host == 'referral';
    final isReferralUniversal = pathParts.length >= 2 && pathParts[0] == 'r';
    if (isReferralScheme || isReferralUniversal) {
      final code = (uri.queryParameters['code'] ??
              (isReferralUniversal ? pathParts[1] : null))
          ?.trim()
          .toUpperCase();
      if (code != null && code.isNotEmpty) {
        if (SecureTokenStore.hasToken) {
          ApiService.navigatorKey.currentState
              ?.pushNamed('/referral', arguments: {'code': code});
        } else {
          _pendingReferralCode = code;
        }
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
          builder: (context, child) => AppUpdateGate(
            child: GlobalClickSoundListener(
              child: child ?? const SizedBox.shrink(),
            ),
          ),
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
              case '/post-auth':
                page = const PostAuthGate();
                break;
              case '/referral-onboarding':
                page = const ReferralOnboardingScreen();
                break;
              case '/':
                page = const MainWrapper();
                break;
              case '/trip':
                page = const TripScreen();
                break;
              case '/credits':
                page = const CreditsScreen();
                break;
              case '/profile':
                page = const ProfileScreen();
                break;
              case '/reset-password':
                final args = settings.arguments as Map<String, dynamic>?;
                page = ResetPasswordScreen(token: args?['token']);
                break;
              case '/special-redemption':
                final args = settings.arguments as Map<String, dynamic>?;
                page = SpecialRedemptionScreen(
                    code: args?['code'] as String?,
                    redemptionId: args?['redemptionId'] as String?);
                break;
              case '/groups':
                final args = settings.arguments as Map<String, dynamic>?;
                page = GroupOpenScreen(groupId: args?['groupId'] as String?);
                break;
              case '/group/join':
                final args = settings.arguments as Map<String, dynamic>?;
                page = GroupJoinScreen(token: (args?['token'] ?? '').toString());
                break;
              case '/referral':
                final args = settings.arguments as Map<String, dynamic>?;
                page = ReferralScreen(
                  initialCode: args?['code']?.toString(),
                );
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