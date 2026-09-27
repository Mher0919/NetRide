import Foundation

/// US phone utilities (mirrors phone_utils.dart).
enum PhoneUtils {
    /// Normalizes to E.164 `+1XXXXXXXXXX` for US numbers.
    static func normalizeUS(_ raw: String) -> String? {
        let digits = raw.filter(\.isNumber)
        var national = digits
        if national.hasPrefix("1") && national.count == 11 { national = String(national.dropFirst()) }
        guard national.count == 10 else { return nil }
        guard national.first != "0", national.first != "1" else { return nil }
        return "+1" + national
    }

    static func format(_ raw: String) -> String {
        let digits = raw.filter(\.isNumber)
        if digits.count == 10 {
            let i = digits.index(digits.startIndex, offsetBy: 3)
            let j = digits.index(i, offsetBy: 3)
            return "(\(digits[..<i])) \(digits[i..<j])-\(digits[j...])"
        }
        return raw
    }
}