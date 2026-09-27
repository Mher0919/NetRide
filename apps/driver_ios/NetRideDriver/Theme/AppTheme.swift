import SwiftUI
import UIKit

/// Mirrors app_theme.dart in the driver app.
enum AppTheme {
    static let primaryBackground = Color(hex: 0xEEEBE6)
    static let primaryBrandGreen = Color(hex: 0x5B7760)
    static let secondaryDarkText = Color(hex: 0x2F3A32)
    static let softBorderColor = Color(hex: 0xD8D2CA)
    static let lightCardBackground = Color(hex: 0xF7F4EF)
    static let successGreen = Color(hex: 0x6E8B74)
    static let errorColor = Color(hex: 0xC65A5A)
    static let warningColor = Color(hex: 0xC79A4A)
    static let connectionBannerRed = Color(hex: 0xB5524A)

    static let acceptFill = Color(hex: 0x5B7760)
    static let acceptTrack = Color(hex: 0xC9D6CC)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b, opacity: alpha)
    }
}

/// Primary button matching driver app style (sage).
struct AppButton: View {
    var title: String
    var icon: String? = nil
    var style: Style = .primary
    var isEnabled: Bool = true
    var action: () -> Void

    enum Style {
        case primary, outlined, dark
    }

    var body: some View {
        Button(action: {
            SoundService.shared.playClick()
            action()
        }) {
            HStack(spacing: 8) {
                if let icon { Image(systemName: icon) }
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundColor(fg)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, 24)
            .background(bg)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(border, lineWidth: 1.5))
            .cornerRadius(16)
        }
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
    }

    private var fg: Color {
        switch style {
        case .primary, .dark: return .white
        case .outlined: return AppTheme.primaryBrandGreen
        }
    }
    private var bg: Color {
        switch style {
        case .primary: return AppTheme.primaryBrandGreen
        case .outlined: return .clear
        case .dark: return .black
        }
    }
    private var border: Color {
        switch style {
        case .outlined: return AppTheme.primaryBrandGreen
        default: return .clear
        }
    }
}

struct AppTextField: View {
    var placeholder: String
    @Binding var text: String
    var isSecure: Bool = false
    var keyboard: UIKeyboardType = .default
    var textContentType: UITextContentType? = nil

    var body: some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
            }
        }
        .keyboardType(keyboard)
        .textContentType(textContentType)
        .font(.system(size: 16))
        .foregroundColor(AppTheme.secondaryDarkText)
        .padding(.vertical, 16)
        .padding(.horizontal, 18)
        .background(Color.white)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor, lineWidth: 1))
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
    }
}

struct AppCard<Content: View>: View {
    var content: Content
    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }
    var body: some View {
        content
            .padding()
            .background(AppTheme.lightCardBackground)
            .cornerRadius(20)
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(AppTheme.softBorderColor, lineWidth: 1))
    }
}