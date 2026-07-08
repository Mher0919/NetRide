bool isTestEmail(String? email) {
  if (email == null) return false;
  final lower = email.toLowerCase();
  final reg = RegExp(r'(^|\+)(test|sandbox|dev)([-_.]|$)', caseSensitive: false);
  if (reg.hasMatch(lower)) return true;
  if (lower.endsWith('@netride.test') || lower.endsWith('@netride.dev')) return true;
  return false;
}

bool isTestTripFor(String? riderEmail, String? driverEmail) {
  return isTestEmail(riderEmail) && isTestEmail(driverEmail);
}
