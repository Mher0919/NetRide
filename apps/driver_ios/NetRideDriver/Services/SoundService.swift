import Foundation
import AVFoundation
import UIKit

/// Mirrors SoundService in the driver app.
final class SoundService {
    static let shared = SoundService()

    private var players: [String: AVAudioPlayer] = [:]

    private init() {}

    func initSounds() {
        let names = ["countdown_tick", "incoming_request", "online", "offline",
                     "order_accepted", "order_cancelled", "tip_received", "trip_completed"]
        for name in names {
            if let url = Bundle.main.url(forResource: name, withExtension: "wav") ?? Bundle.main.url(forResource: name, withExtension: "mp3") {
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
        AudioServicesPlaySystemSound(1104)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func playAlert() {
        AudioServicesPlaySystemSound(1105)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    func setEnabled(_ enabled: Bool) {
        SessionStore.shared.soundEnabled = enabled
    }
}