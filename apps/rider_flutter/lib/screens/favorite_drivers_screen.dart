import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../services/favorite_driver_service.dart';
import '../utils/file_url.dart';

class FavoriteDriversScreen extends StatefulWidget {
  const FavoriteDriversScreen({super.key});

  @override
  State<FavoriteDriversScreen> createState() => _FavoriteDriversScreenState();
}

class _FavoriteDriversScreenState extends State<FavoriteDriversScreen> {
  List<FavoriteDriverInfo>? _favorites;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadFavorites();
  }

  Future<void> _loadFavorites() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final favorites = await FavoriteDriverService.getFavorites();
      if (mounted) {
        setState(() {
          _favorites = favorites;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = 'Could not load favorite drivers.';
          _loading = false;
        });
      }
    }
  }

  Future<void> _removeFavorite(FavoriteDriverInfo driver) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Remove Favorite?'),
        content: Text('Remove ${driver.fullName} from your favorites?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Remove', style: TextStyle(color: Color(0xFFC65A5A))),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    try {
      await FavoriteDriverService.removeFavorite(driver.driverId);
      if (mounted) {
        setState(() {
          _favorites?.removeWhere((f) => f.driverId == driver.driverId);
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${driver.fullName} removed from favorites')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to remove favorite driver.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Favorite Drivers'),
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: const Color(0xFF2F3A32),
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(color: Color(0xFF5B7760)),
      );
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline_rounded, size: 48, color: Color(0xFFC65A5A)),
              const SizedBox(height: 16),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 15, color: Color(0xFF2F3A32)),
              ),
              const SizedBox(height: 24),
              OutlinedButton(
                onPressed: _loadFavorites,
                child: const Text('Try Again'),
              ),
            ],
          ),
        ),
      );
    }

    if (_favorites == null || _favorites!.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.favorite_outline_rounded, size: 64, color: Colors.grey.shade300),
              const SizedBox(height: 16),
              const Text(
                'No favorite drivers yet',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF2F3A32),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'After a ride, you can add a driver to your favorites for priority matching on future trips.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13,
                  color: Colors.grey.shade600,
                ),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadFavorites,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
        itemCount: _favorites!.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, index) {
          final driver = _favorites![index];
          return _buildDriverCard(driver);
        },
      ),
    );
  }

  Widget _buildDriverCard(FavoriteDriverInfo driver) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8D2CA)),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 26,
            backgroundColor: const Color(0xFFF7F4EF),
            backgroundImage: driver.profileImageUrl != null
                ? CachedNetworkImageProvider(resolveFileUrl(driver.profileImageUrl!))
                : null,
            child: driver.profileImageUrl == null
                ? const Icon(Icons.person, color: Color(0xFF5B7760))
                : null,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  driver.fullName,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF2F3A32),
                  ),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    const Icon(Icons.star_rounded, size: 14, color: Color(0xFFC79A4A)),
                    const SizedBox(width: 3),
                    Text(
                      '${driver.rating.toStringAsFixed(1)} · ${driver.ratingCount} rides',
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey.shade600,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          GestureDetector(
            onTap: () => _removeFavorite(driver),
            child: Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFFC65A5A).withOpacity(0.1),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(
                Icons.favorite_rounded,
                size: 18,
                color: Color(0xFFC65A5A),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
