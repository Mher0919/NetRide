class SpatialHash {
  SpatialHash._();

  static const List<String> _base32 = [
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'b', 'c', 'd', 'e', 'f', 'g',
    'h', 'j', 'k', 'm', 'n', 'p', 'q', 'r',
    's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  ];

  static const List<int> _bits = [16, 8, 4, 2, 1];

  static String encode(double lat, double lng, [int precision = 8]) {
    double latMin = -90.0, latMax = 90.0;
    double lngMin = -180.0, lngMax = 180.0;

    final buffer = StringBuffer();
    int hashValue = 0;
    int bit = 0;
    int even = 1;

    while (buffer.length < precision) {
      if (even != 0) {
        final mid = (lngMin + lngMax) / 2;
        if (lng > mid) {
          hashValue |= _bits[bit];
          lngMin = mid;
        } else {
          lngMax = mid;
        }
      } else {
        final mid = (latMin + latMax) / 2;
        if (lat > mid) {
          hashValue |= _bits[bit];
          latMin = mid;
        } else {
          latMax = mid;
        }
      }
      even ^= 1;
      if (bit < 4) {
        bit++;
      } else {
        buffer.write(_base32[hashValue]);
        bit = 0;
        hashValue = 0;
      }
    }

    return buffer.toString();
  }

  static List<String> neighbors(String geohash) {
    final neighbors = <String>{};
    neighbors.add(geohash);

    final lat = _decodeLat(geohash);
    final lng = _decodeLng(geohash);
    final precision = geohash.length;
    final step = _cellSize(precision);

    neighbors.add(encode(lat + step, lng, precision));
    neighbors.add(encode(lat - step, lng, precision));
    neighbors.add(encode(lat, lng + step, precision));
    neighbors.add(encode(lat, lng - step, precision));
    neighbors.add(encode(lat + step, lng + step, precision));
    neighbors.add(encode(lat + step, lng - step, precision));
    neighbors.add(encode(lat - step, lng + step, precision));
    neighbors.add(encode(lat - step, lng - step, precision));

    return neighbors.toList();
  }

  static String routeCacheKey(double originLat, double originLng, double destLat, double destLng, [int precision = 8]) {
    final oHash = encode(originLat, originLng, precision);
    final dHash = encode(destLat, destLng, precision);
    return 'route:$oHash:$dHash';
  }

  static bool isWithinRadius(String hash1, String hash2, {int radiusCells = 2}) {
    if (hash1 == hash2) return true;
    final lat1 = _decodeLat(hash1);
    final lng1 = _decodeLng(hash1);
    final lat2 = _decodeLat(hash2);
    final lng2 = _decodeLng(hash2);
    final precision = hash1.length;
    final cellSize = _cellSize(precision);
    final maxDist = cellSize * radiusCells;
    final dlat = (lat1 - lat2).abs();
    final dlng = (lng1 - lng2).abs();
    return dlat <= maxDist && dlng <= maxDist;
  }

  static double _decodeLat(String geohash) {
    double latMin = -90.0, latMax = 90.0;
    int even = 1;
    double lngMin = -180.0, lngMax = 180.0;

    for (int i = 0; i < geohash.length; i++) {
      final cd = _base32.indexOf(geohash[i]);
      for (int j = 0; j < 5; j++) {
        final mask = _bits[j];
        if (even != 0) {
          final mid = (lngMin + lngMax) / 2;
          if ((cd & mask) != 0) {
            lngMin = mid;
          } else {
            lngMax = mid;
          }
        } else {
          final mid = (latMin + latMax) / 2;
          if ((cd & mask) != 0) {
            latMin = mid;
          } else {
            latMax = mid;
          }
        }
        even ^= 1;
      }
    }
    return (latMin + latMax) / 2;
  }

  static double _decodeLng(String geohash) {
    double lngMin = -180.0, lngMax = 180.0;
    int even = 1;
    double latMin = -90.0, latMax = 90.0;

    for (int i = 0; i < geohash.length; i++) {
      final cd = _base32.indexOf(geohash[i]);
      for (int j = 0; j < 5; j++) {
        final mask = _bits[j];
        if (even != 0) {
          final mid = (lngMin + lngMax) / 2;
          if ((cd & mask) != 0) {
            lngMin = mid;
          } else {
            lngMax = mid;
          }
        } else {
          final mid = (latMin + latMax) / 2;
          if ((cd & mask) != 0) {
            latMin = mid;
          } else {
            latMax = mid;
          }
        }
        even ^= 1;
      }
    }
    return (lngMin + lngMax) / 2;
  }

  static double _cellSize(int precision) {
    switch (precision) {
      case 1: return 5000;
      case 2: return 1250;
      case 3: return 156;
      case 4: return 39;
      case 5: return 4.9;
      case 6: return 1.2;
      case 7: return 0.15;
      case 8: return 0.019;
      case 9: return 0.0024;
      case 10: return 0.0006;
      default: return 0.019;
    }
  }
}
