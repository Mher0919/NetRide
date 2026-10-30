import 'package:flutter/material.dart';

/// Shared low-level skeleton primitives.
///
/// Skeletons are intentionally static in shape and only pulse as a group
/// ([SkeletonPulse]) so a screen never spawns dozens of independent tickers.
/// They are excluded from semantics and are never tappable.
const Color _skeletonBase = Color(0xFFE4DED5);

class SkeletonPulse extends StatefulWidget {
  const SkeletonPulse({super.key, required this.child});

  final Widget child;

  @override
  State<SkeletonPulse> createState() => _SkeletonPulseState();
}

class _SkeletonPulseState extends State<SkeletonPulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
    lowerBound: 0.55,
    upperBound: 1.0,
  );

  bool _animating = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduceMotion = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (reduceMotion) {
      _controller.stop();
      _controller.value = 1;
      _animating = false;
    } else if (!_animating) {
      _animating = true;
      _controller.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: FadeTransition(opacity: _controller, child: widget.child),
    );
  }
}

class SkeletonBox extends StatelessWidget {
  const SkeletonBox({
    super.key,
    this.width,
    required this.height,
    this.borderRadius = 12,
    this.color = _skeletonBase,
  });

  final double? width;
  final double height;
  final double borderRadius;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(borderRadius),
      ),
    );
  }
}

class SkeletonCircle extends StatelessWidget {
  const SkeletonCircle({
    super.key,
    required this.size,
    this.color = _skeletonBase,
  });

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return SkeletonBox(
      width: size,
      height: size,
      borderRadius: size / 2,
      color: color,
    );
  }
}

class SkeletonLine extends StatelessWidget {
  const SkeletonLine({
    super.key,
    this.width,
    this.height = 12,
    this.color = _skeletonBase,
  });

  final double? width;
  final double height;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return SkeletonBox(
      width: width,
      height: height,
      borderRadius: height / 2,
      color: color,
    );
  }
}

class SkeletonCard extends StatelessWidget {
  const SkeletonCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.height,
    this.borderRadius = 20,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double? height;
  final double borderRadius;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      height: height,
      padding: padding,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(borderRadius),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: child,
    );
  }
}

/// Explore / Home skeleton. Mirrors the greeting row, location card, search
/// card, specials strip and the contained map card of the real Explore page.
class ExploreSkeleton extends StatelessWidget {
  const ExploreSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: const [
                SkeletonBox(width: 132, height: 36, borderRadius: 24),
                SkeletonCircle(size: 12),
              ],
            ),
            const SizedBox(height: 14),
            SkeletonCard(
              padding: const EdgeInsets.all(18),
              child: Row(
                children: const [
                  SkeletonCircle(size: 42),
                  SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SkeletonLine(width: 70, height: 10),
                        SizedBox(height: 8),
                        SkeletonLine(width: 180, height: 14),
                      ],
                    ),
                  ),
                  SizedBox(width: 12),
                  SkeletonBox(width: 28, height: 28, borderRadius: 14),
                ],
              ),
            ),
            const SizedBox(height: 10),
            SkeletonCard(
              padding: const EdgeInsets.all(18),
              child: Row(
                children: const [
                  SkeletonCircle(size: 18),
                  SizedBox(width: 12),
                  Expanded(child: SkeletonLine(width: 190, height: 16)),
                ],
              ),
            ),
            const SizedBox(height: 28),
            Row(
              children: const [
                SkeletonLine(width: 110, height: 16),
                Spacer(),
                SkeletonBox(width: 56, height: 22, borderRadius: 12),
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 148,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: 3,
                separatorBuilder: (_, _) => const SizedBox(width: 12),
                itemBuilder: (_, _) => SizedBox(
                  width: 154,
                  child: SkeletonCard(
                    padding: const EdgeInsets.all(10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: const [
                        SkeletonBox(height: 78, borderRadius: 14),
                        SizedBox(height: 10),
                        SkeletonLine(width: 110, height: 12),
                        SizedBox(height: 6),
                        SkeletonLine(width: 72, height: 10),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            const SkeletonBox(height: 260, borderRadius: 28),
          ],
        ),
      ),
    );
  }
}

/// Account screen skeleton: avatar, status pill and information sections.
class ProfileSkeleton extends StatelessWidget {
  const ProfileSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Column(
                children: const [
                  SkeletonCircle(size: 108),
                  SizedBox(height: 14),
                  SkeletonBox(width: 118, height: 26, borderRadius: 13),
                  SizedBox(height: 12),
                  SkeletonLine(width: 96, height: 12),
                ],
              ),
            ),
            const SizedBox(height: 30),
            _section(titleWidth: 120, rows: 4),
            const SizedBox(height: 22),
            _section(titleWidth: 90, rows: 2),
            const SizedBox(height: 22),
            _section(titleWidth: 80, rows: 3),
            const SizedBox(height: 22),
            _section(titleWidth: 78, rows: 2),
          ],
        ),
      ),
    );
  }

  Widget _section({required double titleWidth, required int rows}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SkeletonLine(width: titleWidth, height: 14),
        const SizedBox(height: 10),
        SkeletonCard(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
          child: Column(
            children: [
              for (var i = 0; i < rows; i++) ...[
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Row(
                    children: [
                      const SkeletonBox(width: 22, height: 22, borderRadius: 11),
                      const SizedBox(width: 14),
                      const Expanded(child: SkeletonLine(width: 160, height: 12)),
                      SkeletonBox(
                        width: i.isEven ? 20 : 34,
                        height: 12,
                        borderRadius: 6,
                      ),
                    ],
                  ),
                ),
                if (i != rows - 1) const Divider(height: 1),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// Activity / ride-history skeleton: list of ride cards.
class ActivitySkeleton extends StatelessWidget {
  const ActivitySkeleton({super.key, this.itemCount = 5});

  final int itemCount;

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: ListView.separated(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
        itemCount: itemCount,
        separatorBuilder: (_, _) => const SizedBox(height: 12),
        itemBuilder: (_, _) => SkeletonCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: const [
              Row(
                children: [
                  SkeletonCircle(size: 38),
                  SizedBox(width: 12),
                  Expanded(child: SkeletonLine(width: 140, height: 14)),
                  SkeletonLine(width: 62, height: 12),
                ],
              ),
              SizedBox(height: 16),
              SkeletonLine(width: 210, height: 11),
              SizedBox(height: 8),
              SkeletonLine(width: 170, height: 11),
            ],
          ),
        ),
      ),
    );
  }
}

/// Ride credits skeleton: balance hero + ledger rows.
class CreditsSkeleton extends StatelessWidget {
  const CreditsSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SkeletonBox(height: 156, borderRadius: 20),
            const SizedBox(height: 24),
            const SkeletonLine(width: 170, height: 16),
            const SizedBox(height: 12),
            for (var i = 0; i < 5; i++) ...[
              SkeletonCard(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                child: Row(
                  children: const [
                    SkeletonCircle(size: 34),
                    SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SkeletonLine(width: 130, height: 12),
                          SizedBox(height: 7),
                          SkeletonLine(width: 82, height: 10),
                        ],
                      ),
                    ),
                    SkeletonLine(width: 60, height: 13),
                  ],
                ),
              ),
              const SizedBox(height: 10),
            ],
          ],
        ),
      ),
    );
  }
}

/// Payment-method / wallet skeleton.
class WalletSkeleton extends StatelessWidget {
  const WalletSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SkeletonBox(height: 140, borderRadius: 20),
            const SizedBox(height: 24),
            const SkeletonLine(width: 150, height: 15),
            const SizedBox(height: 12),
            SkeletonCard(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: const [
                  SkeletonBox(width: 46, height: 30, borderRadius: 6),
                  SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SkeletonLine(width: 120, height: 12),
                        SizedBox(height: 7),
                        SkeletonLine(width: 74, height: 10),
                      ],
                    ),
                  ),
                  SkeletonLine(width: 46, height: 11),
                ],
              ),
            ),
            const SizedBox(height: 22),
            const SkeletonLine(width: 130, height: 15),
            const SizedBox(height: 12),
            for (var i = 0; i < 4; i++) ...[
              SkeletonCard(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                child: Row(
                  children: const [
                    SkeletonCircle(size: 32),
                    SizedBox(width: 12),
                    Expanded(child: SkeletonLine(width: 150, height: 11)),
                    SkeletonLine(width: 54, height: 12),
                  ],
                ),
              ),
              const SizedBox(height: 10),
            ],
          ],
        ),
      ),
    );
  }
}

/// Referral / rewards skeleton.
class ReferralSkeleton extends StatelessWidget {
  const ReferralSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SkeletonCard(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: const [
                  SkeletonLine(width: 60, height: 40),
                  SizedBox(height: 12),
                  SkeletonLine(width: 230, height: 16),
                  SizedBox(height: 8),
                  SkeletonLine(width: 180, height: 12),
                ],
              ),
            ),
            const SizedBox(height: 22),
            SkeletonBox(height: 150, borderRadius: 20),
            const SizedBox(height: 18),
            const SkeletonLine(width: 160, height: 15),
            const SizedBox(height: 12),
            for (var i = 0; i < 3; i++) ...[
              SkeletonCard(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                child: Row(
                  children: const [
                    SkeletonCircle(size: 34),
                    SizedBox(width: 12),
                    Expanded(child: SkeletonLine(width: 140, height: 11)),
                    SkeletonLine(width: 52, height: 11),
                  ],
                ),
              ),
              const SizedBox(height: 10),
            ],
          ],
        ),
      ),
    );
  }
}

/// Notifications skeleton: icon + two text lines per row.
class NotificationsSkeleton extends StatelessWidget {
  const NotificationsSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: ListView.separated(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        itemCount: 6,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (_, _) => SkeletonCard(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          child: Row(
            children: const [
              SkeletonCircle(size: 40),
              SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SkeletonLine(width: 180, height: 12),
                    SizedBox(height: 8),
                    SkeletonLine(width: 240, height: 10),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Favorite drivers skeleton.
class FavoriteDriversSkeleton extends StatelessWidget {
  const FavoriteDriversSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: ListView.separated(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        itemCount: 5,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (_, _) => SkeletonCard(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: const [
              SkeletonCircle(size: 52),
              SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SkeletonLine(width: 130, height: 13),
                    SizedBox(height: 8),
                    SkeletonLine(width: 90, height: 10),
                  ],
                ),
              ),
              SkeletonBox(width: 30, height: 30, borderRadius: 15),
            ],
          ),
        ),
      ),
    );
  }
}

/// Gate skeleton shown while the authenticated session profile is resolved.
/// It mirrors the shell of the app without revealing authenticated content
/// or rendering interactive controls that cannot work yet.
class PostAuthSkeleton extends StatelessWidget {
  const PostAuthSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: const Color(0xFF11140F),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
          child: SkeletonPulse(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: const [
                Align(
                  alignment: Alignment.centerLeft,
                  child: SkeletonBox(
                    width: 118,
                    height: 28,
                    borderRadius: 14,
                    color: Color(0xFF2A3029),
                  ),
                ),
                SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerLeft,
                  child: SkeletonBox(
                    width: 210,
                    height: 12,
                    borderRadius: 6,
                    color: Color(0xFF242A24),
                  ),
                ),
                SizedBox(height: 36),
                _DarkCard(child: SkeletonBox(height: 72, borderRadius: 16)),
                SizedBox(height: 14),
                _DarkCard(child: SkeletonBox(height: 72, borderRadius: 16)),
                Spacer(),
                SkeletonBox(
                  height: 54,
                  borderRadius: 14,
                  color: Color(0xFF2A3029),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DarkCard extends StatelessWidget {
  const _DarkCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF1B201A),
        borderRadius: BorderRadius.circular(20),
      ),
      child: child,
    );
  }
}

/// Non-interactive bottom navigation placeholder used while the authenticated
/// shell is being initialized.
class SkeletonBottomNavigation extends StatelessWidget {
  const SkeletonBottomNavigation({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: Container(
        color: Colors.white,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: const [
                _SkeletonNavItem(width: 42),
                _SkeletonNavItem(width: 52),
                _SkeletonNavItem(width: 46),
                _SkeletonNavItem(width: 50),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SkeletonNavItem extends StatelessWidget {
  const _SkeletonNavItem({required this.width});

  final double width;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SkeletonBox(width: 22, height: 22, borderRadius: 6),
        const SizedBox(height: 6),
        SkeletonBox(width: width, height: 8, borderRadius: 4),
      ],
    );
  }
}
