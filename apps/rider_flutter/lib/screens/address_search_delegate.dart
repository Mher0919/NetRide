import 'package:flutter/material.dart';
import '../models/search_result.dart';
import '../services/search/search_controller.dart' as sc;
import '../services/search_history_service.dart';
import '../theme/app_theme.dart';

class AddressSearchDelegate extends SearchDelegate<SearchResult?> {
  final sc.SearchController _controller = sc.SearchController();
  final double? userLat;
  final double? userLon;

  List<SearchResult> _recentSearches = [];
  bool _loadedHistory = false;
  Future<void>? _historyFuture;

  AddressSearchDelegate({this.userLat, this.userLon, String? searchFieldLabel})
      : super(searchFieldLabel: searchFieldLabel) {
    _controller.updateLocation(userLat, userLon);
  }

  Future<void> _loadHistory() async {
    if (_loadedHistory) return;
    _loadedHistory = true;
    _recentSearches = await SearchHistoryService.instance.fetch();
    debugPrint(
      '[SEARCH_DELEGATE] Loaded history: ${_recentSearches.length} searches',
    );
    _refreshDistances();
  }

  void _refreshDistances() {
    if (userLat == null || userLon == null) return;
    for (final result in _recentSearches) {
      result.recalculateFrom(userLat!, userLon!);
    }
  }

  @override
  List<Widget>? buildActions(BuildContext context) {
    return [
      if (query.isNotEmpty)
        IconButton(
          icon: const Icon(Icons.clear),
          onPressed: () {
            query = '';
            _controller.clear();
            showSuggestions(context);
          },
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
    return _buildBody();
  }

  @override
  Widget buildSuggestions(BuildContext context) {
    _controller.onQueryChanged(query);
    return _buildBody();
  }

  Widget _buildBody() {
    // Show recent searches when query is empty (especially for destination)
    if (query.length < 3) {
      _historyFuture ??= _loadHistory();
      return FutureBuilder<void>(
        future: _historyFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(
              child: SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              ),
            );
          }
          return _buildRecentSearches();
        },
      );
    }

    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        switch (_controller.state) {
          case sc.SearchState.idle:
            return _buildRecentSearches();
          case sc.SearchState.loading:
            return const Center(
              child: SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              ),
            );
          case sc.SearchState.results:
            return _buildResultsList();
          case sc.SearchState.empty:
            return _buildNoResults();
          case sc.SearchState.error:
            return _buildError();
        }
      },
    );
  }

  Widget _buildRecentSearches() {
    if (_recentSearches.isEmpty) {
      return _buildEmptyHint();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Text(
            'Recent Searches',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: AppTheme.secondaryDarkText.withOpacity(0.5),
              letterSpacing: 0.5,
            ),
          ),
        ),
        Expanded(
          child: ListView.separated(
            itemCount: _recentSearches.length,
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            separatorBuilder: (_, __) => Divider(
              height: 1,
              color: AppTheme.softBorderColor.withOpacity(0.6),
            ),
            itemBuilder: (context, index) {
              final result = _recentSearches[index];
              return _buildResultTile(
                result,
                Icons.history_rounded,
                iconColor: AppTheme.secondaryDarkText,
                onTap: () => _selectResult(context, result),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _buildResultsList() {
    final results = _controller.results;
    return ListView.separated(
      itemCount: results.length,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      separatorBuilder: (_, __) =>
          Divider(height: 1, color: AppTheme.softBorderColor.withOpacity(0.6)),
      itemBuilder: (context, index) {
        final result = results[index];
        return _buildResultTile(
          result,
          Icons.location_on_rounded,
          onTap: () => _selectResult(context, result),
        );
      },
    );
  }

  Widget _buildResultTile(
    SearchResult result,
    IconData icon, {
    Color? iconColor,
    VoidCallback? onTap,
  }) {
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      leading: Icon(
        icon,
        color: iconColor ?? AppTheme.primaryBrandGreen,
        size: 22,
      ),
      title: Text(
        result.displayName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: AppTheme.secondaryDarkText,
        ),
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Row(
          children: [
            _CaBadge(),
            if (result.displayAddress.isNotEmpty) ...[
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  result.displayAddress,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    color: AppTheme.secondaryDarkText.withOpacity(0.6),
                  ),
                ),
              ),
            ],
            if (result.distanceMiles != null) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  color: AppTheme.primaryBrandGreen.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(3),
                ),
                child: Text(
                  '${result.distanceMiles!.toStringAsFixed(1)} mi',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: AppTheme.primaryBrandGreen.withOpacity(0.8),
                  ),
                ),
              ),
            ],
            if (result.etaText.isNotEmpty) ...[
              const SizedBox(width: 4),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  color: AppTheme.secondaryDarkText.withOpacity(0.08),
                  borderRadius: BorderRadius.circular(3),
                ),
                child: Text(
                  result.etaText,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                    color: AppTheme.secondaryDarkText.withOpacity(0.6),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
      onTap: onTap,
    );
  }

  void _selectResult(BuildContext context, SearchResult result) {
    SearchHistoryService.instance.save(result);
    close(context, result);
  }

  Widget _buildEmptyHint() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.search_rounded,
              size: 48,
              color: AppTheme.softBorderColor,
            ),
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

  Widget _buildNoResults() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.location_off_rounded,
              size: 48,
              color: AppTheme.softBorderColor,
            ),
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

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.wifi_off_rounded,
              size: 48,
              color: AppTheme.errorColor,
            ),
            const SizedBox(height: 12),
            Text(
              _controller.errorMessage ?? 'Unable to search',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: AppTheme.errorColor,
              ),
            ),
            const SizedBox(height: 16),
            TextButton.icon(
              onPressed: () {
                _controller.onQueryChanged(query);
              },
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('Try Again'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}

class _CaBadge extends StatelessWidget {
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
