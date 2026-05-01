import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppTheme {
  // Brand Colors
  static const Color primaryBackground = Color(0xFFEEEBE6);
  static const Color primaryBrandGreen = Color(0xFF5B7760);
  static const Color secondaryDarkText = Color(0xFF2F3A32);
  static const Color softBorderColor = Color(0xFFD8D2CA);
  static const Color lightCardBackground = Color(0xFFF7F4EF);
  static const Color successGreen = Color(0xFF6E8B74);
  static const Color errorColor = Color(0xFFC65A5A);
  static const Color warningColor = Color(0xFFC79A4A);

  static ThemeData get lightTheme {
    return ThemeData(
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
      textTheme: GoogleFonts.interTextTheme().copyWith(
        displayLarge: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
          letterSpacing: -1,
        ),
        headlineMedium: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.5,
        ),
        bodyLarge: GoogleFonts.inter(color: secondaryDarkText),
        bodyMedium: GoogleFonts.inter(color: secondaryDarkText),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primaryBrandGreen,
          foregroundColor: Colors.white,
          elevation: 0,
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 24),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          textStyle: GoogleFonts.inter(
            fontWeight: FontWeight.w600,
            fontSize: 16,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: primaryBrandGreen,
          side: const BorderSide(color: primaryBrandGreen, width: 1.5),
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 24),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          textStyle: GoogleFonts.inter(
            fontWeight: FontWeight.w600,
            fontSize: 16,
          ),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        contentPadding: const EdgeInsets.all(18),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: softBorderColor),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: softBorderColor),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: primaryBrandGreen, width: 1.5),
        ),
        hintStyle: GoogleFonts.inter(color: secondaryDarkText.withOpacity(0.5)),
      ),
      cardTheme: CardThemeData(
        color: lightCardBackground,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: softBorderColor),
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: Colors.white,
        selectedItemColor: primaryBrandGreen,
        unselectedItemColor: Colors.grey,
        showUnselectedLabels: true,
        elevation: 10,
        type: BottomNavigationBarType.fixed,
      ),
      dividerTheme: const DividerThemeData(
        color: softBorderColor,
        thickness: 1,
      ),
    );
  }
}
