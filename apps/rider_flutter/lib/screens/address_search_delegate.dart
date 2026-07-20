import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../theme/app_theme.dart';

class AddressSearchResult {
  final String displayName;
  final double lat;
  final double lon;
  /// Backend tags every result with the literal "CA" so the rider UI
  /// can render the California-only badge. We surface it here so
  /// widgets (map screen, ride request card) can show the same tag
  /// without re-querying.
  final String state;
  /// Distance from the rider's current location, when known. Null
  /// when the rider hasn't granted location permission or the query
  /// didn't pass a lat/lon pair.
  final double? distanceMiles;

  AddressSearchResult({
    required this.displayName,
    required this.lat,
    required this.lon,
    required this.state,
    this.distanceMiles,
  });

  factory AddressSearchResult.fromJson(Map<String, dynamic> json) {
    final distance = json['distance_miles'];
    return AddressSearchResult(
      displayName: (json['display_name'] as String?) ?? '',
      lat: double.parse(json['lat'].toString()),
      lon: double.parse(json['lon'].toString()),
      state: (json['state'] as String?) ?? 'CA',
      distanceMiles: distance is num ? distance.toDouble() : null,
    );
  }
}

class AddressSearchDelegate extends SearchDelegate<AddressSearchResult?> {
  final double? userLat;
  final double? userLon;

  AddressSearchDelegate({this.userLat, this.userLon});

  @override
  List<Widget>? buildActions(BuildContext context) {
    return [
      IconButton(
        icon: const Icon(Icons.clear),
        onPressed: () => query = '',
      ),
    ];
  }

  @override
  Widget? buildLeading(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.arrow_back),
      onPressed: () => close(context, null),
    );
  }

  @override
  Widget buildResults(BuildContext context) {
    return _buildSuggestions();
  }

  @override
  Widget buildSuggestions(BuildContext context) {
    return _buildSuggestions();
  }

  Widget _buildSuggestions() {
    if (query.length < 2) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.search_rounded,
                  size: 48, color: AppTheme.softBorderColor),
              const SizedBox(height: 12),
              const Text(
                'Search for a place or address',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.secondaryDarkText,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'California only — closest matches first',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  color: AppTheme.secondaryDarkText.withOpacity(0.6),
                ),
              ),
            ],
          ),
        ),
      );
    }

    return FutureBuilder<List<AddressSearchResult>>(
      future: _searchAddress(query),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }

        if (snapshot.hasError) {
          return Center(
            child: Text(
              'Error searching address',
              style: TextStyle(color: AppTheme.errorColor),
            ),
          );
        }

        final results = snapshot.data ?? [];

        if (results.isEmpty) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.location_off_rounded,
                      size: 48, color: AppTheme.softBorderColor),
                  const SizedBox(height: 12),
                  const Text(
                    'No matches in California',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.secondaryDarkText,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'NetRide only operates in California right now — try a different search.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.secondaryDarkText.withOpacity(0.65),
                    ),
                  ),
                ],
              ),
            ),
          );
        }

        return ListView.separated(
          itemCount: results.length,
          separatorBuilder: (_, __) => Divider(
            height: 1,
            color: AppTheme.softBorderColor.withOpacity(0.6),
          ),
          itemBuilder: (context, index) {
            final result = results[index];
            return ListTile(
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              leading: const Icon(Icons.location_on_rounded,
                  color: AppTheme.primaryBrandGreen),
              title: Text(
                result.displayName,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.secondaryDarkText,
                ),
              ),
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  children: [
                    _CaBadge(),
                    if (result.distanceMiles != null) ...[
                      const SizedBox(width: 6),
                      Text(
                        '${result.distanceMiles!.toStringAsFixed(1)} mi',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color:
                              AppTheme.secondaryDarkText.withOpacity(0.7),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              onTap: () => close(context, result),
            );
          },
        );
      },
    );
  }

  Future<List<AddressSearchResult>> _searchAddress(String query) async {
    try {
      final Map<String, dynamic> params = {
        'q': query,
        'lat': userLat,
        'lon': userLon,
      };

      final response = await ApiService.dio.get(
        'geospatial/search',
        queryParameters: params,
      );

      final List<dynamic> data = response.data;
      final results = data
          .map((json) => AddressSearchResult.fromJson(json as Map<String, dynamic>))
          .toList();
      // Guarantee nearest-first ordering even if the backend didn't sort
      // (e.g. when the rider's location wasn't available at query time).
      results.sort((a, b) {
        final da = a.distanceMiles;
        final db = b.distanceMiles;
        if (da == null && db == null) return 0;
        if (da == null) return 1;
        if (db == null) return -1;
        return da.compareTo(db);
      });
      return results;
    } catch (e) {
      debugPrint('[SEARCH] ❌ Search failed: $e');
      return [];
    }
  }
}

class _CaBadge extends StatelessWidget {
  const _CaBadge();
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: AppTheme.primaryBrandGreen.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: const Text(
        'CA',
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.6,
          color: AppTheme.primaryBrandGreen,
        ),
      ),
    );
  }
}