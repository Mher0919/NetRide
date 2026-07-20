class SearchConfig {
  SearchConfig._();

  static const int minQueryLength = 2;
  static const int debounceMilliseconds = 300;
  static const int maxResults = 15;
  static const int cacheTtlMinutes = 5;
  static const int nearbySearchDefaultRadiusMiles = 50;
  static const int requestTimeoutSeconds = 8;
  static const String defaultLanguage = 'en';
  static const String defaultRegion = 'CA';
  static const String defaultCountryFilter = 'us';
}
