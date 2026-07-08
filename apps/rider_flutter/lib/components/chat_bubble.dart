// apps/rider_flutter/lib/components/chat_bubble.dart
//
// Reusable chat bubble used by the in-trip messaging sheet. Matches the
// NetRide palette (primaryBrandGreen for "me", lightCardBackground for
// the other party) and the Inter font used throughout the app.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../theme/app_theme.dart';

class ChatBubble extends StatelessWidget {
  final String text;
  final bool isMine;
  final DateTime timestamp;
  final bool pending;

  const ChatBubble({
    super.key,
    required this.text,
    required this.isMine,
    required this.timestamp,
    this.pending = false,
  });

  @override
  Widget build(BuildContext context) {
    final bg = isMine
        ? AppTheme.primaryBrandGreen
        : AppTheme.lightCardBackground;
    final fg = isMine ? Colors.white : AppTheme.secondaryDarkText;
    final align = isMine ? Alignment.centerRight : Alignment.centerLeft;
    final radius = isMine
        ? const BorderRadius.only(
            topLeft: Radius.circular(18),
            topRight: Radius.circular(18),
            bottomLeft: Radius.circular(18),
            bottomRight: Radius.circular(4),
          )
        : const BorderRadius.only(
            topLeft: Radius.circular(18),
            topRight: Radius.circular(18),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(18),
          );

    return Align(
      alignment: align,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.74,
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: radius,
            border: isMine
                ? null
                : Border.all(color: AppTheme.softBorderColor, width: 1),
            boxShadow: isMine
                ? [
                    BoxShadow(
                      color: AppTheme.primaryBrandGreen.withOpacity(0.18),
                      blurRadius: 8,
                      offset: const Offset(0, 3),
                    ),
                  ]
                : null,
          ),
          child: Column(
            crossAxisAlignment:
                isMine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
            children: [
              Text(
                text,
                style: TextStyle(
                  color: fg,
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  height: 1.35,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    DateFormat.jm().format(timestamp),
                    style: TextStyle(
                      color: fg.withOpacity(0.6),
                      fontSize: 10,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  if (isMine && pending) ...[
                    const SizedBox(width: 4),
                    Icon(Icons.schedule, size: 10, color: fg.withOpacity(0.6)),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}