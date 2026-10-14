import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// NetRide design tokens — shared by rider and driver apps.
abstract class AppSpacing {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 20;
  static const double xl = 24;
  static const double xxl = 32;
  static const double pageH = 20;
  /// Standard page bottom padding (keeps content above the home indicator).
  static const double pageBottom = 32;
  static const double cardGap = 12;
  static const double controlH = 48;
}

class AppTheme {
  // Brand Colors
  static const Color primaryBackground = Color(0xFFEEEBE6);
  static const Color primaryBrandGreen = Color(0xFF5B7760);
  static const Color secondaryBrandGreen = Color(0xFF42573F);
  static const Color secondaryDarkText = Color(0xFF2F3A32);
  static const Color softBorderColor = Color(0xFFD8D2CA);
  static const Color lightCardBackground = Color(0xFFF7F4EF);
  static const Color successGreen = Color(0xFF6E8B74);
  static const Color errorColor = Color(0xFFC65A5A);
  static const Color warningColor = Color(0xFFC79A4A);

  static const BorderRadius radiusControl = BorderRadius.all(Radius.circular(12));
  static const BorderRadius radiusCard = BorderRadius.all(Radius.circular(20));

  static ThemeData get lightTheme {
    final base = ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: primaryBackground,
      colorScheme: ColorScheme.light(
        primary: primaryBrandGreen,
        secondary: primaryBrandGreen,
        surface: lightCardBackground,
        error: errorColor,
        onPrimary: Colors.white,
        onSurface: secondaryDarkText,
      ),
    );
    final inter = GoogleFonts.interTextTheme(base.textTheme);

    return base.copyWith(
      textTheme: inter.copyWith(
        displayLarge: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w700,
          letterSpacing: -1,
        ),
        displayMedium: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.5,
        ),
        headlineMedium: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.5,
        ),
        headlineSmall: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
        ),
        titleLarge: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
        ),
        titleMedium: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
        ),
        bodyLarge: GoogleFonts.inter(color: secondaryDarkText),
        bodyMedium: GoogleFonts.inter(color: secondaryDarkText),
        bodySmall: GoogleFonts.inter(color: secondaryDarkText.withValues(alpha: 0.85)),
        labelLarge: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primaryBrandGreen,
          foregroundColor: Colors.white,
          elevation: 0,
          minimumSize: const Size(64, 48),
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 24),
          shape: RoundedRectangleBorder(borderRadius: radiusControl),
          textStyle: inter.labelLarge?.copyWith(
            fontWeight: FontWeight.w600,
            fontSize: 16,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: primaryBrandGreen,
          side: const BorderSide(color: primaryBrandGreen, width: 1.5),
          minimumSize: const Size(64, 48),
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 24),
          shape: RoundedRectangleBorder(borderRadius: radiusControl),
          textStyle: inter.labelLarge?.copyWith(
            fontWeight: FontWeight.w600,
            fontSize: 16,
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: primaryBrandGreen,
          minimumSize: const Size(48, 44),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          shape: RoundedRectangleBorder(borderRadius: radiusControl),
          textStyle: inter.labelLarge?.copyWith(fontSize: 15),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(
          borderRadius: radiusControl,
          borderSide: const BorderSide(color: softBorderColor),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: radiusControl,
          borderSide: const BorderSide(color: softBorderColor),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: radiusControl,
          borderSide: const BorderSide(color: primaryBrandGreen, width: 1.6),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: radiusControl,
          borderSide: const BorderSide(color: errorColor, width: 1.4),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: radiusControl,
          borderSide: const BorderSide(color: errorColor, width: 1.6),
        ),
        hintStyle: inter.bodyMedium?.copyWith(
          color: secondaryDarkText.withValues(alpha: 0.45),
        ),
        labelStyle: inter.bodyMedium?.copyWith(color: secondaryDarkText),
        errorStyle: inter.bodySmall?.copyWith(color: errorColor),
        helperStyle: inter.bodySmall?.copyWith(color: secondaryDarkText.withValues(alpha: 0.75)),
      ),
      cardTheme: CardThemeData(
        color: lightCardBackground,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: radiusCard,
          side: const BorderSide(color: softBorderColor),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: radiusCard),
        titleTextStyle: inter.titleLarge?.copyWith(
          fontSize: 20,
          fontWeight: FontWeight.w700,
          color: secondaryDarkText,
        ),
        contentTextStyle: inter.bodyMedium?.copyWith(color: secondaryDarkText),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: secondaryDarkText,
        contentTextStyle: inter.bodyMedium?.copyWith(color: Colors.white),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: radiusControl),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: primaryBrandGreen,
        foregroundColor: Colors.white,
        elevation: 2,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return Colors.white;
          return Colors.grey.shade400;
        }),
        trackColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return primaryBrandGreen;
          return Colors.grey.shade300;
        }),
      ),
      dividerTheme: const DividerThemeData(
        color: softBorderColor,
        thickness: 1,
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: Colors.white,
        selectedItemColor: primaryBrandGreen,
        unselectedItemColor: Colors.grey,
        showUnselectedLabels: true,
        elevation: 10,
        type: BottomNavigationBarType.fixed,
      ),
      splashFactory: InkSparkle.splashFactory,
      pageTransitionsTheme: const PageTransitionsTheme(builders: {
        TargetPlatform.android: ZoomPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      }),
    );
  }
}