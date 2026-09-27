import Foundation
import Supabase

/// Singleton Supabase client (mirrors Supabase.initialize in driver main.dart).
enum SupabaseManager {
    static let shared = SupabaseManager()

    let client: SupabaseClient

    private init() {
        client = SupabaseClient(
            supabaseURL: URL(string: EnvConfig.supabaseURL)!,
            supabaseKey: EnvConfig.supabaseAnonKey
        )
    }

    var hasSession: Bool {
        client.auth.currentSession != nil
    }
}