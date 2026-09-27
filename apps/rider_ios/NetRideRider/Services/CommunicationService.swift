import Foundation
import Combine

/// Mirrors CommunicationService in the rider app: chat + masked-call state.
final class CommunicationService: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var callPhase: CallPhase = .idle
    @Published var lastError: String?

    private var tripId: String?
    private var riderId: String?
    private var peerName: String?
    private var callToken: String?
    private var conferenceName: String?

    var currentPeerName: String? { peerName }

    func attach(socket: SocketService, riderId: String, tripId: String, peerName: String) {
        self.riderId = riderId
        self.tripId = tripId
        self.peerName = peerName

        socket.off("messageReceived")
        socket.off("messageDelivered")
        socket.off("error")
        socket.off("callEnded")

        socket.on("messageReceived") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            let msg = ChatMessage(json: dict)
            if msg.role != "rider" { return }
            self.messages.append(msg)
        }
        socket.on("messageDelivered") { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            let deliveredId = (dict["id"] as? String) ?? ""
            if let idx = self.messages.firstIndex(where: { $0.pending == true }) {
                var msg = self.messages[idx]
                msg.id = deliveredId
                msg.pending = false
                msg.failed = false
                self.messages[idx] = msg
            }
        }
        socket.on("error") { [weak self] data, _ in
            guard let self else { return }
            let raw = (data.first as? String) ?? ((data.first as? [String: Any])?["message"] as? String) ?? ""
            let lower = raw.lowercased()
            if lower.contains("too quickly") || lower.contains("only available") || lower.contains("not part")
                || lower.contains("message") || lower.contains("active trip") {
                for i in self.messages.indices where self.messages[i].pending == true {
                    self.messages[i].failed = true
                    self.messages[i].pending = false
                }
            } else if !lower.isEmpty {
                self.lastError = raw
            }
        }
        socket.on("callEnded") { [weak self] _, _ in
            self?.endCall()
        }
    }

    func loadHistory(tripId: String) async throws {
        let res = try await APIClient.request("GET", "ride/\(tripId)/messages")
        let map = res as? [String: Any] ?? [:]
        let arr = map["messages"] as? [[String: Any]] ?? []
        self.messages = arr.map { ChatMessage(json: $0) }
    }

    func sendMessage(text: String, socket: SocketService) {
        guard !text.isEmpty, text.count <= 1000 else { return }
        let msg = ChatMessage(senderId: riderId ?? "", role: "rider", message: text, timestamp: Date(), pending: true)
        messages.append(msg)
        guard let tripId else { return }
        socket.emit("sendMessage", ["tripId": tripId, "message": text])
    }

    func retryMessage(at index: Int, socket: SocketService) {
        guard messages.indices.contains(index), messages[index].failed else { return }
        let text = messages[index].message
        messages[index].failed = false
        messages[index].pending = true
        guard let tripId else { return }
        socket.emit("sendMessage", ["tripId": tripId, "message": text])
    }

    func clearError() {
        lastError = nil
    }

    // MARK: - Masked calls

    func startCall(tripId: String) async throws {
        callPhase = .connecting
        let res = try await APIClient.request("POST", "ride/\(tripId)/call-token")
        let map = res as? [String: Any] ?? [:]
        self.callToken = map["token"] as? String
        self.conferenceName = map["conferenceName"] as? String
        callPhase = .ringing
    }

    func markCallConnected() {
        callPhase = .connected
    }

    func endCall() {
        callPhase = .ended
        callToken = nil
        conferenceName = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.callPhase = .idle
        }
    }

    func toggleMute() {
        // Mute is handled by the platform voice layer in the full implementation.
    }
}

enum CallPhase {
    case idle, ringing, connecting, connected, ended, failed
}