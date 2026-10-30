import 'package:flutter/material.dart';

/// Shared skeleton primitives for the driver app.
///
/// One [SkeletonPulse] wraps a screen's static placeholder layout, keeping the
/// animation restrained and avoiding one ticker per placeholder box.
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

/// Driver dashboard skeleton: greeting/status card, compliance card, weekly
/// earnings, contained map card and the circular online control placeholder.
class DriverDashboardSkeleton extends StatelessWidget {
  const DriverDashboardSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SkeletonCard(
                padding: const EdgeInsets.all(18),
                child: Row(
                  children: const [
                    SkeletonCircle(size: 42),
                    SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SkeletonLine(width: 128, height: 14),
                          SizedBox(height: 8),
                          SkeletonLine(width: 96, height: 10),
                        ],
                      ),
                    ),
                    SkeletonBox(width: 76, height: 24, borderRadius: 12),
                  ],
                ),
              ),
              const SizedBox(height: 10),
              SkeletonCard(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: const [
                    SkeletonCircle(size: 22),
                    SizedBox(width: 12),
                    Expanded(child: SkeletonLine(width: 210, height: 12)),
                  ],
                ),
              ),
              const SizedBox(height: 10),
              SkeletonCard(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: const [
                    SkeletonLine(width: 74, height: 10),
                    SizedBox(height: 10),
                    SkeletonLine(width: 140, height: 30),
                    SizedBox(height: 14),
                    Divider(height: 1),
                    SizedBox(height: 12),
                    Row(
                      children: [
                        SkeletonCircle(size: 16),
                        SizedBox(width: 8),
                        Expanded(child: SkeletonLine(width: 90, height: 11)),
                        SkeletonLine(width: 64, height: 11),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              Expanded(
                child: LayoutBuilder(
                  builder: (_, constraints) => SkeletonBox(
                    height: constraints.maxHeight,
                    borderRadius: 28,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              const Center(child: SkeletonCircle(size: 76)),
            ],
          ),
        ),
      ),
    );
  }
}

/// Driver account skeleton: avatar, verification pill, information sections.
class DriverProfileSkeleton extends StatelessWidget {
  const DriverProfileSkeleton({super.key});

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
                  SkeletonBox(width: 160, height: 26, borderRadius: 13),
                  SizedBox(height: 12),
                  SkeletonLine(width: 96, height: 12),
                ],
              ),
            ),
            const SizedBox(height: 30),
            _section(titleWidth: 122, rows: 4),
            const SizedBox(height: 22),
            _section(titleWidth: 96, rows: 3),
            const SizedBox(height: 22),
            _section(titleWidth: 80, rows: 2),
            const SizedBox(height: 22),
            _section(titleWidth: 86, rows: 3),
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

/// Driver activity skeleton.
class DriverActivitySkeleton extends StatelessWidget {
  const DriverActivitySkeleton({super.key, this.itemCount = 5});

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

/// Driver onboarding skeleton: step indicator, heading, headshot circle and
/// the primary action placeholder.
class OnboardingSkeleton extends StatelessWidget {
  const OnboardingSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SafeArea(
        child: SingleChildScrollView(
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: List.generate(
                    6,
                    (_) => const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 4),
                      child: SkeletonBox(width: 20, height: 4, borderRadius: 2),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 36),
              const SkeletonLine(width: 180, height: 24),
              const SizedBox(height: 10),
              const SkeletonLine(width: 240, height: 12),
              const SizedBox(height: 36),
              const Center(child: SkeletonCircle(size: 160)),
              const SizedBox(height: 32),
              const SkeletonBox(height: 56, borderRadius: 12),
              const SizedBox(height: 16),
              const SkeletonBox(height: 56, borderRadius: 12),
              const SizedBox(height: 40),
              const SkeletonBox(height: 56, borderRadius: 12),
            ],
          ),
        ),
      ),
    );
  }
}

/// Generic document/vehicle detail skeleton used by content-driven driver
/// screens while their first request is in flight.
class DriverDetailSkeleton extends StatelessWidget {
  const DriverDetailSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return SkeletonPulse(
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SkeletonLine(width: 190, height: 20),
            const SizedBox(height: 10),
            const SkeletonLine(width: 250, height: 12),
            const SizedBox(height: 24),
            SkeletonCard(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: const [
                  SkeletonLine(width: 120, height: 12),
                  SizedBox(height: 12),
                  SkeletonBox(height: 96, borderRadius: 12),
                  SizedBox(height: 12),
                  SkeletonLine(width: 180, height: 11),
                ],
              ),
            ),
            const SizedBox(height: 14),
            SkeletonCard(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: const [
                  SkeletonLine(width: 140, height: 12),
                  SizedBox(height: 12),
                  SkeletonBox(height: 96, borderRadius: 12),
                  SizedBox(height: 12),
                  SkeletonLine(width: 160, height: 11),
                ],
              ),
            ),
            const SizedBox(height: 24),
            const SkeletonBox(height: 54, borderRadius: 12),
          ],
        ),
      ),
    );
  }
}

/// Non-interactive bottom nav placeholder for the driver shell.
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
                _SkeletonNavItem(width: 44),
                _SkeletonNavItem(width: 50),
                _SkeletonNavItem(width: 48),
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
