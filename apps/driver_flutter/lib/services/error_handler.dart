// lib/services/error_handler.dart
//
// CENTRALIZED AUTHENTICATION ERROR TRANSLATION LAYER
//
// This is the SINGLE source of truth for turning technical failures
// (Supabase exceptions, Dio/HTTP errors, raw backend payloads, networking
// failures, programming errors) into safe, human-readable messages.
//
// UI code MUST NEVER display `e.toString()`, `e.message`, HTTP status
// strings, or backend error bodies directly. Always route through
// [ErrorHandler.friendly] (or the category helpers below).
//
// Internal/technical details are intentionally dropped here so they can be
// logged server-side but never reach the end user.

import 'package:dio/dio.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class ErrorHandler {
  ErrorHandler._();

  /// Translate any thrown error into a friendly, end-user-safe message.
  ///
  /// Order of precedence:
  ///   1. Known structured backend error codes/messages (mapped explicitly).
  ///   2. Network / connectivity failures.
  ///   3. Supabase / Auth exceptions.
  ///   4. Dio HTTP errors (status-code aware, message never exposed).
  ///   5. Generic fallback.
  static String friendly(Object? error, {String fallback = 'Something unexpected happened. Please try again.'}) {
    if (error == null) return fallback;

    // ---- 1. Structured backend payloads (Dio) -------------------------
    if (error is DioException) {
      return _fromDio(error, fallback);
    }

    // ---- 2. Supabase auth / Postgrest exceptions ----------------------
    if (error is AuthException) {
      return _fromSupabaseAuth(error.message);
    }
    if (error is PostgrestException) {
      return _fromSupabasePostgrest(error.message, error.code);
    }

    // ---- 3. Plain exceptions with known wording -----------------------
    final raw = error.toString();
    final mapped = _mapKnownMessage(raw);
    if (mapped != null) return mapped;

    // ---- 4. Generic fallback (never leaks internals) ------------------
    return fallback;
  }

  /// Convenience helper used by callers that already hold the exception.
  static String of(dynamic error) => friendly(error);

  // ───────────────────────────────────────────────────────────────────
  // Dio / HTTP
  // ───────────────────────────────────────────────────────────────────
  static String _fromDio(DioException e, String fallback) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        return 'The connection timed out. Please check your internet and try again.';
      case DioExceptionType.connectionError:
        return 'We couldn\'t connect to the server. Please check your internet connection and try again.';
      case DioExceptionType.cancel:
        return fallback;
      case DioExceptionType.unknown:
        if (e.error != null) {
          final s = e.error.toString().toLowerCase();
          if (s.contains('socket') || s.contains('network') || s.contains('connection')) {
            return 'We couldn\'t connect to the server. Please check your internet connection and try again.';
          }
        }
        // fall through to response handling if available
        break;
      case DioExceptionType.badResponse:
        break;
      default:
        break;
    }

    // Response errors (status code aware; message never shown).
    if (e.response != null) {
      final status = e.response!.statusCode ?? 0;
      final backendMsg = _backendMessage(e.response!.data);
      final mapped = backendMsg != null ? _mapKnownMessage(backendMsg) : null;
      if (mapped != null) return mapped;

      if (status >= 500) {
        return 'Something went wrong on our side. Please try again in a few moments.';
      }
      if (status == 429) {
        return 'You\'ve made too many requests. Please wait a moment before trying again.';
      }
      if (status == 401 || status == 403) {
        return 'Your session is no longer valid. Please sign in again.';
      }
      if (status == 404) {
        return 'We couldn\'t find what you were looking for. Please try again.';
      }
      if (status == 400) {
        // A 400 usually carries a mapped backend message; if not, be generic.
        return mapped ?? 'We couldn\'t process that request. Please check your information and try again.';
      }
      return 'We couldn\'t complete that request. Please try again.';
    }

    return fallback;
  }

  // ───────────────────────────────────────────────────────────────────
  // Supabase
  // ───────────────────────────────────────────────────────────────────
  static String _fromSupabaseAuth(String message) {
    final mapped = _mapKnownMessage(message);
    if (mapped != null) return mapped;
    // AuthException message often contains provider jargon; never expose it.
    final lower = message.toLowerCase();
    if (lower.contains('email') && (lower.contains('not confirm') || lower.contains('not verified'))) {
      return 'Please verify your email address before signing in.';
    }
    if (lower.contains('user not found') || lower.contains('invalid login')) {
      return 'The email or password you entered is incorrect.';
    }
    return 'We couldn\'t sign you in. Please try again.';
  }

  static String _fromSupabasePostgrest(String message, String? code) {
    final mapped = _mapKnownMessage(message);
    if (mapped != null) return mapped;
    if (code == '23505') {
      return 'This number is already registered.';
    }
    return 'Something went wrong while saving your information. Please try again.';
  }

  // ───────────────────────────────────────────────────────────────────
  // Backend payload extraction
  // ───────────────────────────────────────────────────────────────────
  static String? _backendMessage(dynamic data) {
    if (data is Map<String, dynamic>) {
      final candidates = <String?>[
        data['error'] as String?,
        data['message'] as String?,
        data['msg'] as String?,
      ];
      for (final c in candidates) {
        if (c != null && c.trim().isNotEmpty) return c;
      }
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────
  // Known-message mapping (backend phrasing → friendly copy)
  // ───────────────────────────────────────────────────────────────────
  static String? _mapKnownMessage(String raw) {
    final m = raw.toLowerCase();

    // Phone / OTP
    if (m.contains('already registered') || m.contains('already exists') || m.contains('already in use')) {
      return 'This number is already registered.';
    }
    if (m.contains('not found') || m.contains('no account') || m.contains('unknown user')) {
      return 'We couldn\'t find an account with that email.';
    }
    if (m.contains('expired')) {
      return 'Your verification code has expired. Please request a new one.';
    }
    if (m.contains('invalid') && (m.contains('otp') || m.contains('code') || m.contains('verification'))) {
      return 'The verification code you entered is incorrect.';
    }
    if (m.contains('too many') || m.contains('rate limit') || m.contains('rate_limit')) {
      return 'You\'ve requested verification too many times. Please wait before trying again.';
    }
    if (m.contains('otp') || m.contains('verification code') && m.contains('send')) {
      return 'We couldn\'t send a verification code right now. Please try again.';
    }

    // Credentials
    if (m.contains('invalid login') || m.contains('invalid credential') || m.contains('incorrect') || m.contains('wrong password') || m.contains('bad password')) {
      return 'The email or password you entered is incorrect.';
    }
    if (m.contains('email not confirmed') || m.contains('not verified')) {
      return 'Please verify your account before signing in.';
    }

    // Generic network / server
    if (m.contains('network') || m.contains('socket') || m.contains('connection') || m.contains('errno')) {
      return 'We couldn\'t connect to the server. Please check your internet connection and try again.';
    }
    if (m.contains('timeout')) {
      return 'The request took too long. Please check your connection and try again.';
    }
    if (m.contains('jwt') || m.contains('token') && m.contains('expired') || m.contains('unauthorized') || m.contains('401')) {
      return 'Your session has expired. Please sign in again.';
    }
    if (m.contains('500') || m.contains('internal server error') || m.contains('bad gateway') || m.contains('service unavailable')) {
      return 'Something went wrong on our side. Please try again in a few moments.';
    }
    if (m.contains('duplicate') || m.contains('unique constraint') || m.contains('23505')) {
      return 'This number is already registered.';
    }
    if (m.contains('weak password') || m.contains('password')) {
      return 'That password doesn\'t meet our requirements. Please choose a stronger one.';
    }

    return null;
  }

  // ───────────────────────────────────────────────────────────────────
  // Phone / OTP specific friendly helpers (Requirement 6)
  // ───────────────────────────────────────────────────────────────────
  static String phoneAlreadyRegistered() =>
      'This number is already registered.';
  static String phoneNotFound() =>
      'We couldn\'t find an account with that phone number.';
  static String invalidPhone() =>
      'Please enter a valid 10-digit US phone number.';
  static String unableToSendCode() =>
      'We couldn\'t send a verification code right now. Please try again.';
  static String tooManyAttempts() =>
      'You\'ve requested verification too many times. Please wait before trying again.';
  static String incorrectCode() =>
      'The verification code you entered is incorrect.';
  static String codeExpired() =>
      'Your verification code has expired. Please request a new one.';
  static String networkUnavailable() =>
      'Please check your internet connection and try again.';
  static String unexpected() => 'Something unexpected happened. Please try again.';
}
