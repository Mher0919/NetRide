import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppTheme {
  // Brand Colors (new logo: dark green #294C3A background, cream #D0CFBA text)
  static const Color primaryBackground = Color(0xFF294C3A);
  static const Color primaryBrandGreen = Color(0xFFD0CFBA);
  static const Color secondaryDarkText = Color(0xFFD0CFBA);
  static const Color softBorderColor = Color(0xFF3D5F4D);
  static const Color lightCardBackground = Color(0xFF315646);
  static const Color successGreen = Color(0xFF7FAE8C);
  static const Color errorColor = Color(0xFFE07373);
  static const Color warningColor = Color(0xFFE0B04F);

  static ThemeData get lightTheme {
    return ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: primaryBackground,
      colorScheme: ColorScheme.light(
        primary: primaryBrandGreen,
        secondary: primaryBrandGreen,
        surface: lightCardBackground,
        error: errorColor,
        onPrimary: primaryBackground,
        onSurface: secondaryDarkText,
      ),
      textTheme: GoogleFonts.interTextTheme().copyWith(
        displayLarge: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
          letterSpacing: -1,
        ),
        displayMedium: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
        ),
        displaySmall: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
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
        titleSmall: GoogleFonts.inter(
          color: secondaryDarkText,
          fontWeight: FontWeight.w600,
        ),
        bodyLarge: GoogleFonts.inter(color: secondaryDarkText),
        bodyMedium: GoogleFonts.inter(color: secondaryDarkText),
        bodySmall: GoogleFonts.inter(color: secondaryDarkText),
        labelLarge: GoogleFonts.inter(color: secondaryDarkText),
        labelMedium: GoogleFonts.inter(color: secondaryDarkText),
        labelSmall: GoogleFonts.inter(color: secondaryDarkText),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primaryBrandGreen,
          foregroundColor: primaryBackground,
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
        fillColor: lightCardBackground,
        contentPadding: const EdgeInsets.all(18),
        labelStyle: GoogleFonts.inter(color: secondaryDarkText),
        floatingLabelStyle: GoogleFonts.inter(color: primaryBrandGreen),
        hintStyle: GoogleFonts.inter(color: secondaryDarkText.withOpacity(0.5)),
        prefixIconColor: secondaryDarkText.withOpacity(0.7),
        suffixIconColor: secondaryDarkText.withOpacity(0.7),
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
        backgroundColor: primaryBackground,
        selectedItemColor: primaryBrandGreen,
        unselectedItemColor: Color(0xFF8FA391),
        showUnselectedLabels: true,
        elevation: 10,
        type: BottomNavigationBarType.fixed,
      ),
      dividerTheme: const DividerThemeData(
        color: softBorderColor,
        thickness: 1,
      ),
      appBarTheme: const AppBarThemeData(
        backgroundColor: primaryBackground,
        foregroundColor: secondaryDarkText,
        elevation: 0,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: lightCardBackground,
        surfaceTintColor: Colors.transparent,
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: lightCardBackground,
        surfaceTintColor: Colors.transparent,
      ),
      textSelectionTheme: const TextSelectionThemeData(
        cursorColor: primaryBrandGreen,
        selectionColor: Color(0x55D0CFBA),
        selectionHandleColor: primaryBrandGreen,
      ),
      dropdownMenuTheme: DropdownMenuThemeData(
        textStyle: GoogleFonts.inter(color: secondaryDarkText),
        menuStyle: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(lightCardBackground),
          surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        ),
      ),
    );
  }
}
