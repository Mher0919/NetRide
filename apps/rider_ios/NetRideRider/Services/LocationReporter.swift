import Foundation
import CoreLocation
import Combine

/// Throttles location updates (mirrors LocationReporter in the rider app).
final class LocationReporter {
    private var minInterval: TimeInterval
    private var minDistanceM: Double
    private var maxStaleInterval: TimeInterval
    private var lastEmit: Date?
    private var lastLocation: CLLocation?

    init(minInterval: TimeInterval = 1, minDistanceM: Double = 5, maxStaleInterval: TimeInterval = 10) {
        self.minInterval = minInterval
        self.minDistanceM = minDistanceM
        self.maxStaleInterval = maxStaleInterval
    }

    func shouldReport(location: CLLocation) -> Bool {
        let now = Date()
        if let last = lastEmit {
            let interval = now.timeIntervalSince(last)
            if interval < minInterval {
                if interval > maxStaleInterval {
                    lastEmit = now
                    return true
                }
                return false
            }
            if let lastLoc = lastLocation {
                let dist = lastLoc.distance(from: location)
                if dist < minDistanceM { return false }
            }
        }
        lastEmit = now
        lastLocation = location
        return true
    }
}