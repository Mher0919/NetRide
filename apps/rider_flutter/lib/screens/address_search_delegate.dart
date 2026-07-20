import 'package:flutter/material.dart';
import '../models/search_result.dart';
import '../services/search/search_controller.dart' as sc;
import '../theme/app_theme.dart';

class AddressSearchDelegate extends SearchDelegate<SearchResult?> {
  final sc.SearchController _controller = sc.SearchController();
  final double? userLat;
  final double? userLon;

  AddressSearchDelegate({this.userLat, this.userLon}) {
    _controller.updateLocation(userLat, userLon);
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
    if (query.length < 2) {
      return _buildEmptyHint();
    }

    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        switch (_controller.state) {
          case sc.SearchState.idle:
            return _buildEmptyHint();
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

  Widget _buildEmptyHint() {
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

  Widget _buildResultsList() {
    final results = _controller.results;
    return ListView.separated(
      itemCount: results.length,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
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
                      color: AppTheme.secondaryDarkText.withOpacity(0.7),
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
  }

  Widget _buildNoResults() {
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

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded,
                size: 48, color: AppTheme.errorColor),
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
