import Foundation
import SocketIO

/// Wraps the Socket.IO client for the driver app.
final class SocketService {
    static let shared = SocketService()

    private(set) var manager: SocketManager?
    private(set) var socket: SocketIOClient?
    private(set) var isConnected = false
    private var queuedHandlers: [(event: String, handler: ([Any], SocketAckEmitter) -> Void)] = []

    private init() {}

    var isActive: Bool { socket != nil }

    func connect(token: String) {
        if socket != nil { disconnect() }

        let url = URL(string: EnvConfig.socketBaseUrl) ?? URL(string: "https://netride.onrender.com")!
        let config: SocketIOClientConfiguration = [
            .log(false),
            .forceNew(true),
            .forceWebsockets(true),
            .reconnects(true),
            .reconnectAttempts(-1),
            .reconnectWait(1),
            .reconnectWaitMax(15),
            .randomizationFactor(0.5),
            .connectParams(["token": token, "role": "DRIVER"]),
            .extraHeaders(["Authorization": "Bearer \(token)"]),
        ]
        manager = SocketManager(socketURL: url, config: config)
        socket = manager?.defaultSocket

        socket?.on(clientEvent: .connect) { [weak self] _, _ in
            self?.isConnected = true
            NotificationCenter.default.post(name: .socketConnected, object: nil)
        }
        socket?.on(clientEvent: .disconnect) { [weak self] _, _ in
            self?.isConnected = false
            NotificationCenter.default.post(name: .socketDisconnected, object: nil)
        }
        socket?.on(clientEvent: .error) { [weak self] _, _ in
            self?.isConnected = false
            NotificationCenter.default.post(name: .socketDisconnected, object: nil)
        }

        // Re-apply persistent handlers to the fresh socket.
        for entry in queuedHandlers {
            socket?.on(entry.event, callback: entry.handler)
        }
        socket?.connect()
    }

    func disconnect() {
        socket?.disconnect()
        socket = nil
        manager = nil
        isConnected = false
    }

    func on(_ event: String, _ handler: @escaping ([Any], SocketAckEmitter) -> Void) {
        if let socket {
            socket.on(event, callback: handler)
        } else {
            queuedHandlers.append((event, handler))
        }
    }

    func off(_ event: String) {
        socket?.off(event)
    }

    func emit(_ event: String, _ payload: [String: Any]) {
        socket?.emit(event, payload)
    }

    func emit(_ event: String, _ items: SocketData...) {
        socket?.emit(event, items)
    }
}

extension Notification.Name {
    static let socketConnected = Notification.Name("socketConnected")
    static let socketDisconnected = Notification.Name("socketDisconnected")
}