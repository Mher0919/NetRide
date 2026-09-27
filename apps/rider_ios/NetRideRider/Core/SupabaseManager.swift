import Foundation
import Supabase

/// Singleton Supabase client (mirrors Supabase.initialize in main.dart).
final class SupabaseManager {
    static let shared = SupabaseManager()

    let client: SupabaseClient

    private init() {
        client = SupabaseClient(
            supabaseURL: URL(string: EnvConfig.supabaseURL)!,
            supabaseKey: EnvConfig.supabaseAnonKey
        )
    }

    var currentUserEmail: String? {
        client.auth.currentUser?.email
    }

    var hasSession: Bool {
        client.auth.currentSession != nil
    }
}