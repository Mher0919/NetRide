import 'dart:async';
import 'package:flutter/foundation.dart';
import '../../models/search_result.dart';
import 'search_service.dart';
import 'search_config.dart';

enum SearchState { idle, loading, results, empty, error }

class SearchController extends ChangeNotifier {
  final SearchService _service = SearchService();

  SearchState _state = SearchState.idle;
  SearchState get state => _state;

  List<SearchResult> _results = [];
  List<SearchResult> get results => _results;

  String? _errorMessage;
  String? get errorMessage => _errorMessage;

  Timer? _debounce;
  String _currentQuery = '';
  String _pendingQuery = '';

  double? _lat;
  double? _lon;

  void updateLocation(double? lat, double? lon) {
    _lat = lat;
    _lon = lon;
  }

  void onQueryChanged(String query) {
    _pendingQuery = query;

    _debounce?.cancel();
    if (query.trim().length < SearchConfig.minQueryLength) {
      _setState(SearchState.idle);
      _results = [];
      _currentQuery = '';
      return;
    }

    if (query == _currentQuery) return;

    _debounce = Timer(
      Duration(milliseconds: SearchConfig.debounceMilliseconds),
      _executeSearch,
    );
  }

  Future<void> _executeSearch() async {
    final query = _pendingQuery.trim();
    if (query.length < SearchConfig.minQueryLength) return;
    if (query == _currentQuery) return;

    _currentQuery = query;
    _setState(SearchState.loading);

    try {
      final results = await _service.search(
        query: query,
        lat: _lat,
        lon: _lon,
      );

      if (query != _currentQuery) return;

      _results = results;

      if (results.isEmpty) {
        _setState(SearchState.empty);
      } else {
        _setState(SearchState.results);
      }
    } catch (e) {
      if (query != _currentQuery) return;
      _errorMessage = 'Unable to search. Please check your connection and try again.';
      _results = [];
      _setState(SearchState.error);
    }
  }

  void _setState(SearchState newState) {
    _state = newState;
    notifyListeners();
  }

  void cancel() {
    _debounce?.cancel();
    _service.cancelPending();
  }

  void clear() {
    cancel();
    _state = SearchState.idle;
    _results = [];
    _currentQuery = '';
    _pendingQuery = '';
    _errorMessage = null;
    notifyListeners();
  }

  @override
  void dispose() {
    cancel();
    super.dispose();
  }
}
