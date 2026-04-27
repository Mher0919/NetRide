import 'package:flutter/material.dart';
import 'package:dio/dio.dart';

class AddressSearchResult {
  final String displayName;
  final double lat;
  final double lon;

  AddressSearchResult({required this.displayName, required this.lat, required this.lon});

  factory AddressSearchResult.fromJson(Map<String, dynamic> json) {
    return AddressSearchResult(
      displayName: json['display_name'],
      lat: double.parse(json['lat']),
      lon: double.parse(json['lon']),
    );
  }
}

class AddressSearchDelegate extends SearchDelegate<AddressSearchResult?> {
  final Dio _dio = Dio();
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
      return const Center(child: Text('Search for addresses or places (e.g. In-N-Out)'));
    }

    return FutureBuilder<List<AddressSearchResult>>(
      future: _searchAddress(query),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }

        if (snapshot.hasError) {
          return const Center(child: Text('Error searching address'));
        }

        final results = snapshot.data ?? [];

        return ListView.builder(
          itemCount: results.length,
          itemBuilder: (context, index) {
            final result = results[index];
            return ListTile(
              leading: const Icon(Icons.location_on),
              title: Text(result.displayName),
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
        'format': 'json',
        'addressdetails': 1,
        'limit': 10,
      };

      // If we have user location, bias results to that area (approx 20km box)
      if (userLat != null && userLon != null) {
        params['viewbox'] = '${userLon! - 0.2},${userLat! + 0.2},${userLon! + 0.2},${userLat! - 0.2}';
        // params['bounded'] = 0; // Bias towards viewbox but allow results outside
      }

      final response = await _dio.get(
        'https://nominatim.openstreetmap.org/search',
        queryParameters: params,
        options: Options(headers: {'User-Agent': 'UberishApp/1.0'}),
      );

      final List<dynamic> data = response.data;
      return data.map((json) => AddressSearchResult.fromJson(json)).toList();
    } catch (e) {
      return [];
    }
  }
}
