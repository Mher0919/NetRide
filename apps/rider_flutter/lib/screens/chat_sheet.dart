// apps/rider_flutter/lib/screens/chat_sheet.dart
//
// Modal bottom sheet that shows the live chat thread between the rider
// and the driver. Loads history on open, listens to the
// CommunicationService for incoming + delivered events, and lets the
// rider type + send messages with the send button.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../components/chat_bubble.dart';
import '../services/communication_service.dart';
import '../theme/app_theme.dart';

class ChatSheet extends StatefulWidget {
  final String tripId;
  final String peerName;

  const ChatSheet({
    super.key,
    required this.tripId,
    required this.peerName,
  });

  @override
  State<ChatSheet> createState() => _ChatSheetState();
}

class _ChatSheetState extends State<ChatSheet> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  final FocusNode _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<CommunicationService>().loadHistory().then((_) => _scrollToBottom());
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(
      _scrollController.position.maxScrollExtent,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
    );
  }

  void _handleSend() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    context.read<CommunicationService>().sendMessage(text);
    _controller.clear();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<CommunicationService>(
      builder: (context, comm, _) {
        // Auto-scroll on new message.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (comm.messages.isNotEmpty) _scrollToBottom();
        });
        return SafeArea(
          top: false,
          child: Padding(
            padding: EdgeInsets.only(
              bottom: MediaQuery.of(context).viewInsets.bottom,
            ),
            child: Container(
              height: MediaQuery.of(context).size.height * 0.72,
              decoration: const BoxDecoration(
                color: AppTheme.primaryBackground,
                borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
              ),
              child: Column(
                children: [
                  const SizedBox(height: 12),
                  Container(
                    width: 38,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AppTheme.softBorderColor,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  _buildHeader(comm),
                  const Divider(height: 1, color: AppTheme.softBorderColor),
                  Expanded(child: _buildBody(comm)),
                  if (comm.lastError != null) _buildErrorBar(comm),
                  _buildComposer(),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildHeader(CommunicationService comm) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 14),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: const BoxDecoration(
              color: AppTheme.primaryBrandGreen,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: const Icon(Icons.local_taxi, color: Colors.white, size: 20),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Chat with your driver',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1,
                    color: AppTheme.primaryBrandGreen,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  widget.peerName,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    color: AppTheme.secondaryDarkText,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Close',
            icon: const Icon(Icons.keyboard_arrow_down_rounded, color: AppTheme.secondaryDarkText),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }

  Widget _buildBody(CommunicationService comm) {
    if (comm.loadingHistory && comm.messages.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(color: AppTheme.primaryBrandGreen),
      );
    }
    if (comm.messages.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.chat_bubble_outline, color: AppTheme.softBorderColor, size: 56),
              const SizedBox(height: 12),
              const Text(
                'No messages yet',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 16,
                  color: AppTheme.secondaryDarkText,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                'Send a quick “I’m at the pickup” to get started.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13,
                  color: AppTheme.secondaryDarkText.withOpacity(0.6),
                ),
              ),
            ],
          ),
        ),
      );
    }
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      itemCount: comm.messages.length,
      itemBuilder: (context, index) {
        final msg = comm.messages[index];
        return ChatBubble(
          text: msg.message,
          isMine: msg.role == 'rider',
          timestamp: msg.timestamp,
          pending: msg.pending,
          failed: msg.failed,
          onRetry: msg.failed ? () => comm.retryMessage(index) : null,
        );
      },
    );
  }

  Widget _buildErrorBar(CommunicationService comm) {
    return GestureDetector(
      onTap: () => comm.clearError(),
      child: Container(
        width: double.infinity,
        color: AppTheme.errorColor.withOpacity(0.08),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            const Icon(Icons.info_outline, size: 16, color: AppTheme.errorColor),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                comm.lastError!,
                style: const TextStyle(
                  color: AppTheme.errorColor,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const Icon(Icons.close, size: 14, color: AppTheme.errorColor),
          ],
        ),
      ),
    );
  }

  Widget _buildComposer() {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(top: BorderSide(color: AppTheme.softBorderColor)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: TextField(
              controller: _controller,
              focusNode: _focusNode,
              minLines: 1,
              maxLines: 5,
              textCapitalization: TextCapitalization.sentences,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _handleSend(),
              decoration: InputDecoration(
                hintText: 'Message your driver…',
                filled: true,
                fillColor: AppTheme.lightCardBackground,
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide.none,
                ),
                hintStyle: TextStyle(color: AppTheme.secondaryDarkText.withOpacity(0.5)),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Material(
            color: AppTheme.primaryBrandGreen,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _handleSend,
              child: const Padding(
                padding: EdgeInsets.all(12),
                child: Icon(Icons.send_rounded, color: Colors.white, size: 20),
              ),
            ),
          ),
        ],
      ),
    );
  }
}