import Foundation
import CoreLocation
import Combine

/// Mirrors GpsTracker in the driver app.
final class GpsTracker: NSObject, ObservableObject {
    static let shared = GpsTracker()

    enum GpsStatus {
        case tracking, permissionDenied, serviceDisabled, signalLost
    }

    let fixes = PassthroughSubject<GpsFix, Never>()
    @Published private(set) var status: GpsStatus = .tracking

    private let manager = CLLocationManager()
    private var isStarted = false
    private var lastFixTime: Date?
    private var lastHeading: Double?
    private(set) var lastKnownLocation: CLLocationCoordinate2D?

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = 2
    }

    func start() {
        guard !isStarted else { return }
        isStarted = true
        let authorized = manager.authorizationStatus == .authorizedWhenInUse
            || manager.authorizationStatus == .authorizedAlways
        if !authorized {
            status = .permissionDenied
            manager.requestWhenInUseAuthorization()
        }
        manager.startUpdatingLocation()
        manager.startUpdatingHeading()
    }

    func stop() {
        isStarted = false
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }
}

struct GpsFix {
    var position: CLLocationCoordinate2D
    var headingDeg: Double
    var speedMps: Double
    var timestamp: Date
}

extension GpsTracker: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            status = .permissionDenied
        case .notDetermined:
            break
        default:
            status = .tracking
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let coord = location.coordinate
        if coord.latitude == 0 && coord.longitude == 0 { return }
        if location.horizontalAccuracy > 50 { return }

        // Wall-clock throttle 1s
        let now = Date()
        if let last = lastFixTime, now.timeIntervalSince(last) < 1 { return }
        lastFixTime = now

        let heading = location.course >= 0 ? location.course : (lastHeading ?? 0)
        lastHeading = heading
        lastKnownLocation = coord
        status = .tracking
        fixes.send(GpsFix(position: coord, headingDeg: heading, speedMps: max(location.speed, 0), timestamp: now))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        status = .signalLost
    }
}