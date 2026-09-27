import Foundation

/// Friendly error mapping (mirrors ErrorHandler in the Flutter rider app).
enum ErrorHandler {
    static func message(for error: Error) -> String {
        if let api = error as? APIError {
            return api.errorDescription ?? "Something went wrong. Please try again."
        }
        if let ns = error as NSError? {
            if ns.domain == NSURLErrorDomain {
                switch ns.code {
                case NSURLErrorNotConnectedToInternet:
                    return "No internet connection. Please check your network."
                case NSURLErrorTimedOut:
                    return "This is taking too long. Please try again."
                default:
                    break
                }
            }
        }
        let raw = error.localizedDescription.lowercased()
        if raw.contains("invalid or expired verification code") || raw.contains("invalid code") || raw.contains("expired") {
            return "That code is invalid or has expired. Please request a new one."
        }
        if raw.contains("incorrect email or password") {
            return "Incorrect email or password."
        }
        if raw.contains("email not verified") {
            return "Please verify your email first."
        }
        if raw.contains("already exists") || raw.contains("duplicate") {
            return "An account with this email already exists."
        }
        if raw.contains("weak password") || raw.contains("password") && raw.contains("min") {
            return "Your password must be at least 8 characters, include a capital letter, a number, and a special character."
        }
        if raw.contains("401") || raw.contains("unauthorized") {
            return "Please sign in again."
        }
        if raw.contains("429") || raw.contains("too many requests") {
            return "You're doing that too often. Please wait a moment and try again."
        }
        return "Something went wrong. Please try again."
    }
}