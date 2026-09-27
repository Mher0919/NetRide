import Foundation

/// Friendly error mapping (mirrors ErrorHandler in the driver app).
enum ErrorHandler {
    static func message(for error: Error) -> String {
        if let api = error as? APIError {
            return api.errorDescription ?? "Something went wrong. Please try again."
        }
        if let ns = error as NSError?, ns.domain == NSURLErrorDomain {
            if ns.code == NSURLErrorNotConnectedToInternet {
                return "No internet connection. Please check your network."
            }
            if ns.code == NSURLErrorTimedOut {
                return "This is taking too long. Please try again."
            }
        }
        let raw = error.localizedDescription.lowercased()
        if raw.contains("invalid or expired verification code") || raw.contains("expired") {
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
        if raw.contains("already submitted") {
            return "Application already submitted. We'll review it shortly."
        }
        if raw.contains("profile change pending") {
            return "You already have a profile change under review. Please wait for it to be approved."
        }
        if raw.contains("rate limited") {
            return "You're doing that too often. Please wait 24 hours and try again."
        }
        if raw.contains("phone not verified") {
            return "Please verify your phone number first."
        }
        return "Something went wrong. Please try again."
    }
}