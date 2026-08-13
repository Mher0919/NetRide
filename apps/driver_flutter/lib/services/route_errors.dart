enum RouteErrorCategory {
  locationUnavailable,
  invalidOrigin,
  invalidDestination,
  noRouteFound,
  networkError,
  timeout,
  apiAuthentication,
  apiPermission,
  apiQuota,
  rateLimited,
  malformedRequest,
  routeCancelled,
  unknown,
}

class RouteError {
  final RouteErrorCategory category;
  final String message;
  final String? debugInfo;
  final bool isRetryable;
  final bool isTransient;

  const RouteError({
    required this.category,
    required this.message,
    this.debugInfo,
    this.isRetryable = false,
    this.isTransient = false,
  });

  String get userFacingMessage {
    switch (category) {
      case RouteErrorCategory.locationUnavailable:
        return "We couldn't get your current location. Please make sure location services are enabled.";
      case RouteErrorCategory.invalidOrigin:
        return "Your current location could not be determined. Please check your GPS signal and try again.";
      case RouteErrorCategory.invalidDestination:
        return "The destination coordinates appear to be invalid. Please try again.";
      case RouteErrorCategory.noRouteFound:
        return "A route could not be found between your current location and the pickup point.";
      case RouteErrorCategory.networkError:
        return "We couldn't reach the routing service. Check your internet connection and try again.";
      case RouteErrorCategory.timeout:
        return "The route calculation took too long. Please try again.";
      case RouteErrorCategory.apiAuthentication:
      case RouteErrorCategory.apiPermission:
      case RouteErrorCategory.apiQuota:
      case RouteErrorCategory.rateLimited:
      case RouteErrorCategory.malformedRequest:
        return "We're having trouble loading the route right now. Please try again.";
      case RouteErrorCategory.routeCancelled:
        return "Route calculation was cancelled.";
      case RouteErrorCategory.unknown:
        return "We're having trouble loading the route right now. Please try again.";
    }
  }
}

class RouteValidator {
  static const double _minLat = -90;
  static const double _maxLat = 90;
  static const double _minLng = -180;
  static const double _maxLng = 180;
  static const double _sentinelZeroThreshold = 0.0001;

  static RouteError? validateOrigin(double? lat, double? lng, {DateTime? timestamp, double? accuracy}) {
    if (lat == null || lng == null) {
      return RouteError(
        category: RouteErrorCategory.locationUnavailable,
        message: 'Origin coordinates are null',
        isRetryable: true,
        isTransient: true,
      );
    }

    if (lat.isNaN || lng.isNaN || lat.isInfinite || lng.isInfinite) {
      return RouteError(
        category: RouteErrorCategory.invalidOrigin,
        message: 'Origin coordinates are NaN or infinite',
      );
    }

    if (lat < _minLat || lat > _maxLat || lng < _minLng || lng > _maxLng) {
      return RouteError(
        category: RouteErrorCategory.invalidOrigin,
        message: 'Origin coordinates out of bounds: $lat, $lng',
      );
    }

    if (lat.abs() < _sentinelZeroThreshold && lng.abs() < _sentinelZeroThreshold) {
      return RouteError(
        category: RouteErrorCategory.locationUnavailable,
        message: 'Origin is at sentinel (0,0) - uninitialized GPS',
        isRetryable: true,
        isTransient: true,
      );
    }

    return null;
  }

  static RouteError? validateDestination(double? lat, double? lng) {
    if (lat == null || lng == null) {
      return RouteError(
        category: RouteErrorCategory.invalidDestination,
        message: 'Destination coordinates are null',
      );
    }

    if (lat.isNaN || lng.isNaN || lat.isInfinite || lng.isInfinite) {
      return RouteError(
        category: RouteErrorCategory.invalidDestination,
        message: 'Destination coordinates are NaN or infinite',
      );
    }

    if (lat < _minLat || lat > _maxLat || lng < _minLng || lng > _maxLng) {
      return RouteError(
        category: RouteErrorCategory.invalidDestination,
        message: 'Destination coordinates out of bounds: $lat, $lng',
      );
    }

    return null;
  }

  static bool isLocationFresh(DateTime? timestamp, {Duration maxAge = const Duration(seconds: 30)}) {
    if (timestamp == null) return false;
    return DateTime.now().difference(timestamp).abs() <= maxAge;
  }

  static bool isAccuracyAcceptable(double? accuracy, {double maxAccuracy = 50}) {
    if (accuracy == null) return false;
    return accuracy <= maxAccuracy;
  }
}
