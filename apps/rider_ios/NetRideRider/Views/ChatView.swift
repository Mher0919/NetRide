import SwiftUI

/// Modal chat thread (mirrors ChatSheet).
struct ChatView: View {
    var tripId: String
    var peerName: String
    @EnvironmentObject var communication: CommunicationService
    @State private var draft = ""
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Chat with \(peerName)")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)
                Spacer()
            }
            .padding()
            .background(AppTheme.primaryBackground)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(Array(communication.messages.enumerated()), id: \.offset) { idx, msg in
                            chatBubble(msg, index: idx)
                                .id(idx)
                        }
                    }
                    .padding()
                }
                .onChange(of: communication.messages.count) { _ in
                    if let last = communication.messages.indices.last {
                        withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                    }
                }
            }

            if let error = communication.lastError {
                HStack {
                    Text(error).font(.system(size: 12)).foregroundColor(AppTheme.errorColor)
                    Spacer()
                    Button("Dismiss") { communication.clearError() }
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(AppTheme.primaryBrandGreen)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }

            HStack(spacing: 10) {
                TextField("Message", text: $draft)
                    .padding(12)
                    .background(AppTheme.lightCardBackground)
                    .cornerRadius(20)
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundColor(AppTheme.primaryBrandGreen)
                }
            }
            .padding()
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
        }
    }

    @ViewBuilder
    private func chatBubble(_ msg: ChatMessage, index: Int) -> some View {
        let isMine = msg.role == "rider"
        HStack {
            if isMine { Spacer(minLength: 60) }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
                Text(msg.message)
                    .font(.system(size: 15))
                    .foregroundColor(AppTheme.secondaryDarkText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(isMine ? AppTheme.primaryBrandGreen.opacity(0.85) : Color(hex: 0xF0EADF))
                    .cornerRadius(16, corners: isMine ? [.topLeft, .topRight, .bottomLeft] : [.topLeft, .topRight, .bottomRight])
                    .foregroundColor(isMine ? .white : AppTheme.secondaryDarkText)
                if msg.pending {
                    Text("Sending…").font(.system(size: 11)).foregroundColor(AppTheme.softBorderColor)
                } else if msg.failed {
                    Button("Failed to send · Tap to retry") {
                        communication.retryMessage(at: index, socket: SocketService.shared)
                    }
                    .font(.system(size: 11))
                    .foregroundColor(AppTheme.errorColor)
                }
            }
            if !isMine { Spacer(minLength: 60) }
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        communication.sendMessage(text: text, socket: SocketService.shared)
        draft = ""
    }
}