import Foundation

/// Centralized HTTP client for the rider app (mirrors Dio + interceptor in api_service.dart).
///
/// Every request attaches the JWT bearer token. On a 401 that included a token,
/// it attempts a single-flight backend session sync via `AuthService.syncWithBackend()`
/// and retries the original request exactly once (`X-Already-Retried` header guard).
enum APIClient {
    static var baseURL: URL { URL(string: EnvConfig.apiUrl)! }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    static func request(
        _ method: String,
        _ path: String,
        body: [String: Any]? = nil,
        query: [String: String]? = nil,
        timeout: TimeInterval = 30,
        uploadBase64: (image: String, mimetype: String, filename: String)? = nil
    ) async throws -> Any {
        var url = baseURL.appendingPathComponent(path)
        if let query {
            var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
            url = comps.url!
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = SessionStore.shared.jwtToken, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let upload = uploadBase64 {
            let payload: [String: Any] = [
                "image": upload.image,
                "mimetype": upload.mimetype,
                "filename": upload.filename,
            ]
            req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        } else if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.network
        }

        if http.statusCode == 401, req.value(forHTTPHeaderField: "X-Already-Retried") != "true",
           req.value(forHTTPHeaderField: "Authorization") != nil,
           !(req.value(forHTTPHeaderField: "Authorization") ?? "").isEmpty {
            let refreshed = try? await AuthService.syncWithBackend()
            if refreshed == true, let newToken = SessionStore.shared.jwtToken {
                var retry = req
                retry.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
                retry.setValue("true", forHTTPHeaderField: "X-Already-Retried")
                let (retryData, retryResponse) = try await session.data(for: retry)
                if let retryHTTP = retryResponse as? HTTPURLResponse {
                    return try Self.decode(retryData, status: retryHTTP.statusCode)
                }
            }
            await AuthService.logout()
            return try Self.decode(data, status: http.statusCode)
        }

        return try Self.decode(data, status: http.statusCode)
    }

    private static func decode(_ data: Data, status: Int) throws -> Any {
        guard status >= 200, status < 300 else {
            var message: String? = nil
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                message = (obj["error"] as? String) ?? (obj["message"] as? String) ?? (obj["msg"] as? String)
            }
            throw APIError.server(status: status, message: message)
        }
        return try JSONSerialization.jsonObject(with: data)
    }
}

enum APIError: LocalizedError {
    case network
    case server(status: Int, message: String?)
    case invalidData

    var errorDescription: String? {
        switch self {
        case .network:
            return "No internet connection. Please check your network and try again."
        case .server(_, let message):
            return message ?? "Something went wrong. Please try again."
        case .invalidData:
            return "We couldn't process the server response. Please try again."
        }
    }
}