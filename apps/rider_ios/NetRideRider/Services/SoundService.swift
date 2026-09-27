import Foundation
import AVFoundation
import UIKit

/// Mirrors SoundService in the rider app.
final class SoundService {
    static let shared = SoundService()

    private var players: [String: AVAudioPlayer] = [:]

    private init() {}

    func initSounds() {
        for name in ["order_accepted", "order_cancelled", "trip_completed", "tip_received"] {
            if let url = Bundle.main.url(forResource: name, withExtension: "mp3") ?? Bundle.main.url(forResource: name, withExtension: "wav") {
                players[name] = try? AVAudioPlayer(contentsOf: url)
            }
        }
    }

    private var enabled: Bool { SessionStore.shared.soundEnabled }

    func play(_ name: String) {
        guard enabled else { return }
        players[name]?.stop()
        players[name]?.currentTime = 0
        players[name]?.play()
    }

    func playClick() {
        AudioServicesPlaySystemSound(1104) // keyboard tap click
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func playAlert() {
        AudioServicesPlaySystemSound(1105) // system alert
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    func setEnabled(_ enabled: Bool) {
        SessionStore.shared.soundEnabled = enabled
    }
}