import SwiftUI

/// Masked-call presentation (mirrors CallOverlay in the rider app).
struct CallOverlayView: View {
    var phase: CallPhase
    var peerName: String
    var onEnd: () -> Void
    var onMute: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.9).ignoresSafeArea()
            VStack(spacing: 24) {
                Circle()
                    .fill(AppTheme.primaryBrandGreen)
                    .frame(width: 90, height: 90)
                    .overlay(
                        Text(peerName.prefix(1).uppercased())
                            .font(.system(size: 40, weight: .bold))
                            .foregroundColor(.white)
                    )
                Text(phaseLabel)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)

                if phase == .connected {
                    Button {
                        onMute()
                    } label: {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 26))
                            .foregroundColor(.white)
                            .frame(width: 70, height: 70)
                            .background(AppTheme.secondaryDarkText)
                            .clipShape(Circle())
                    }
                }

                Button {
                    onEnd()
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 26))
                        .foregroundColor(.white)
                        .frame(width: 70, height: 70)
                        .background(AppTheme.errorColor)
                        .clipShape(Circle())
                }
            }
        }
    }

    private var phaseLabel: String {
        switch phase {
        case .connecting: return "CONNECTING…"
        case .ringing: return "RINGING…"
        case .connected: return "IN CALL"
        case .ended: return "CALL ENDED"
        case .failed: return "CALL FAILED"
        case .idle: return ""
        }
    }
}