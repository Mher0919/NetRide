import Foundation
import CoreLocation

/// Throttles location updates (mirrors LocationReporter in the driver app).
final class LocationReporter {
    private var minInterval: TimeInterval
    private var minDistanceM: Double
    private var minHeadingDeltaDeg: Double
    private var maxStaleInterval: TimeInterval
    private var lastEmit: Date?
    private var lastLocation: CLLocation?
    private var lastHeading: Double?

    init(minInterval: TimeInterval = 1, minDistanceM: Double = 10, minHeadingDeltaDeg: Double = 15, maxStaleInterval: TimeInterval = 4) {
        self.minInterval = minInterval
        self.minDistanceM = minDistanceM
        self.minHeadingDeltaDeg = minHeadingDeltaDeg
        self.maxStaleInterval = maxStaleInterval
    }

    func shouldReport(location: CLLocation, heading: Double?) -> Bool {
        let now = Date()
        if let last = lastEmit {
            let interval = now.timeIntervalSince(last)
            if interval < minInterval {
                if interval > maxStaleInterval {
                    lastEmit = now
                    lastLocation = location
                    lastHeading = heading
                    return true
                }
                return false
            }
            if let lastLoc = lastLocation {
                let dist = lastLoc.distance(from: location)
                if dist < minDistanceM {
                    if let heading, let lastHeading, minHeadingDeltaDeg > 0 {
                        let delta = abs((heading - lastHeading + 180).truncatingRemainder(dividingBy: 360) - 180)
                        if delta < minHeadingDeltaDeg { return false }
                    } else {
                        return false
                    }
                }
            }
        }
        lastEmit = now
        lastLocation = location
        lastHeading = heading
        return true
    }
}