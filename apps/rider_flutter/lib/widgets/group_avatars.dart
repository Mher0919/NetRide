import 'package:flutter/material.dart';
import '../models/group_models.dart';
import '../theme/app_theme.dart';
import '../utils/file_url.dart';

class GroupAvatar extends StatelessWidget {
  const GroupAvatar({
    super.key,
    required this.name,
    this.imageUrl,
    this.size = 44,
    this.highlight = false,
  });

  final String name;
  final String? imageUrl;
  final double size;
  final bool highlight;

  String get _initials {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final raw = imageUrl;
    final url = raw != null && raw.isNotEmpty ? resolveFileUrl(raw) : null;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: highlight
            ? AppTheme.primaryBrandGreen.withValues(alpha: 0.18)
            : const Color(0xFFE4DED5),
        border: highlight
            ? Border.all(color: AppTheme.primaryBrandGreen, width: 1.5)
            : null,
      ),
      clipBehavior: Clip.antiAlias,
      child: url != null
          ? Image.network(
              url,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => _initialsLabel(),
            )
          : _initialsLabel(),
    );
  }

  Widget _initialsLabel() {
    return Center(
      child: Text(
        _initials,
        style: TextStyle(
          fontSize: size * 0.36,
          fontWeight: FontWeight.w800,
          color: AppTheme.secondaryDarkText.withValues(alpha: 0.75),
        ),
      ),
    );
  }
}

class GroupAvatarStack extends StatelessWidget {
  const GroupAvatarStack({
    super.key,
    required this.participants,
    this.size = 42,
    this.max = 3,
  });

  final List<GroupParticipant> participants;
  final double size;
  final int max;

  @override
  Widget build(BuildContext context) {
    final shown = participants.take(max).toList();
    final overlap = size * 0.30;
    final width = shown.isEmpty
        ? size
        : size + (shown.length - 1) * (size - overlap);
    return SizedBox(
      width: width,
      height: size,
      child: Stack(
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * (size - overlap),
              child: Container(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white, width: 2),
                ),
                child: GroupAvatar(
                  name: shown[i].fullName,
                  imageUrl: shown[i].profileImageUrl,
                  size: size,
                  highlight: shown[i].isHost,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
