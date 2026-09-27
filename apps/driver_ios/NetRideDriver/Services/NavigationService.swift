import Foundation
import CoreLocation
import Combine
import AVFoundation

/// Mirrors NavigationService + NavigationVoiceService + route-matching helpers.
final class NavigationService: ObservableObject {
    @Published private(set) var leg: String = "pickup"
    @Published private(set) var route: NavigationRoute?
    @Published private(set) var progress: RouteProgress?
    @Published private(set) var isNavigating = false
    @Published private(set) var offRoute = false
    @Published private(set) var rerouting = false
    @Published private(set) var currentSpeed: Double = 0
    @Published private(set) var currentSpeedLimit: Double = 30
    @Published private(set) var isSpeeding = false
    @Published private(set) var currentRoad: String?
    @Published var routeError: String?

    private var tripId: String?
    private var matcher: RouteMatcher?
    private var cancelables = Set<AnyCancellable>()
    private var routeRequestVersion = 0
    private var gpsSub: AnyCancellable?
    private var rerouteController = RerouteController()
    private var speedMonitor = SpeedMonitor()
    private var lastAnnouncedStep = -1
    private var lastAnnouncedThreshold = ""

    private let voice = NavigationVoiceService.instance

    // MARK: - Start

    func startNavigation(tripId: String, leg: String, start: Location, end: Location, cachedRoute: NavigationRoute? = nil) {
        self.tripId = tripId
        self.leg = leg
        routeRequestVersion += 1
        let version = routeRequestVersion
        routeError = nil

        if let cachedRoute, !cachedRoute.points.isEmpty {
            applyRoute(cachedRoute, version: version)
            return
        }

        Task {
            do {
                if let cached = try? await RoutingService.getCachedLeg(tripId: tripId, leg: leg),
                   !cached.points.isEmpty {
                    guard version == routeRequestVersion else { return }
                    applyRoute(cached, version: version)
                    return
                }
                let response = try await RoutingService.getRoute(start: start, end: end)
                guard version == routeRequestVersion else { return }
                var nav = NavigationRoute(json: nil)
                nav.points = response.geometry
                nav.steps = response.steps
                nav.distance = response.distanceMeters
                nav.duration = response.durationSeconds
                nav.trafficDurationSeconds = response.trafficDurationSeconds
                nav.speedLimitsByRoad = response.speedLimitsByRoad
                nav.engine = response.engine
                nav.cacheHit = response.cacheHit
                applyRoute(nav, version: version)
            } catch {
                if version == routeRequestVersion {
                    routeError = Self.classifyError(error)
                }
            }
        }
    }

    func advanceToDestination(start: Location, end: Location, cachedRoute: NavigationRoute? = nil) {
        guard leg == "pickup" else { return }
        leg = "destination"
        if let tripId {
            startNavigation(tripId: tripId, leg: leg, start: start, end: end, cachedRoute: cachedRoute)
        }
    }

    func stopNavigation() {
        gpsSub?.cancel()
        gpsSub = nil
        matcher = nil
        route = nil
        progress = nil
        isNavigating = false
        offRoute = false
        rerouting = false
        speedMonitor.stop()
        voice.stop()
        GpsTracker.shared.stop()
        rerouteController.reset()
    }

    func requestReroute(from position: CLLocationCoordinate2D) {
        guard let tripId, !rerouting else { return }
        rerouting = true
        Task {
            do {
                let nav = try await RoutingService.requestReroute(tripId: tripId, leg: leg, lat: position.latitude, lng: position.longitude)
                if let nav, !nav.points.isEmpty {
                    applyRoute(nav, version: routeRequestVersion)
                }
            } catch {
                // Ignore — keep current route.
            }
            rerouting = false
        }
    }

    // MARK: - Route application + GPS

    private func applyRoute(_ route: NavigationRoute, version: Int) {
        guard version == routeRequestVersion else { return }
        self.route = route
        matcher = RouteMatcher(route: route.points)
        speedMonitor.start(route: route)
        currentSpeedLimit = speedMonitor.speedLimitMph
        currentRoad = speedMonitor.roadName

        isNavigating = true
        GpsTracker.shared.start()
        gpsSub = GpsTracker.shared.fixes.sink { [weak self] fix in
            self?.onGpsFix(fix)
        }
        rerouteController.reset()
        speakRoutePreview(route)
    }

    private func onGpsFix(_ fix: GpsFix) {
        currentSpeed = fix.speedMps
        speedMonitor.update(speedMps: fix.speedMps)
        currentSpeed = speedMonitor.speedMph
        isSpeeding = speedMonitor.isSpeeding
        currentSpeedLimit = speedMonitor.speedLimitMph
        currentRoad = speedMonitor.roadName

        guard let route, let matcher else { return }
        let headingValid = fix.speedMps > 0.5
        guard let snap = matcher.match(gps: fix.position, headingDeg: headingValid ? fix.headingDeg : nil) else { return }

        let computed = RouteProgressCalculator.compute(
            gps: fix.position,
            polyline: route.points,
            steps: route.steps,
            speedMps: fix.speedMps,
            totalMeters: route.distance ?? 0,
            snap: snap
        )
        progress = computed

        // Off-route detection
        let detectorFired = OffRouteDetector.shared.consider(
            snap: snap,
            speed: fix.speedMps,
            heading: fix.headingDeg,
            headingValid: headingValid
        )
        if detectorFired {
            offRoute = true
            rerouteController.onOffRoute(snap: snap, position: fix.position) { [weak self] shouldBackend in
                if shouldBackend {
                    self?.requestReroute(from: fix.position)
                }
            }
        } else {
            offRoute = rerouteController.monitoring(offRoute: offRoute, snap: snap, position: fix.position)
        }

        // Voice announcements
        announceIfNeeded(stepIndex: computed.currentStepIndex, remainingMeters: computed.remainingMeters)
    }

    private func announceIfNeeded(stepIndex: Int, remainingMeters: Double) {
        let route = self.route
        guard let steps = route?.steps, steps.count > stepIndex else { return }
        let thresholdKey = Self.thresholdKey(for: remainingMeters)
        if stepIndex > lastAnnouncedStep || (thresholdKey != lastAnnouncedThreshold && !thresholdKey.isEmpty && remainingMeters > 20) {
            let step = steps[stepIndex]
            let road = step.name ?? ""
            let modifier = Self.voiceModifier(step.maneuver)
            if stepIndex > lastAnnouncedStep {
                let dist = Self.distanceLabel(remainingMeters)
                voice.speak("In \(dist), \(modifier) onto \(road).")
                lastAnnouncedStep = stepIndex
                lastAnnouncedThreshold = thresholdKey
            } else if !thresholdKey.isEmpty && remainingMeters > 20 {
                let dist = Self.distanceLabel(remainingMeters)
                voice.speak("In \(dist), \(modifier) onto \(road).")
                lastAnnouncedThreshold = thresholdKey
            }
        }
    }

    private func speakRoutePreview(_ route: NavigationRoute) {
        guard let steps = route.steps, !steps.isEmpty else { return }
        let firstRoad = steps[0].name ?? ""
        if firstRoad.isEmpty {
            voice.speak("Head forward.")
        } else {
            voice.speak("Head onto \(firstRoad).")
        }
        if steps.count > 1 {
            let step = steps[1]
            let road = step.name ?? ""
            let modifier = Self.voiceModifier(step.maneuver)
            if !road.isEmpty {
                voice.speak("In 500 feet, \(modifier) onto \(road).")
            }
        }
    }

    // MARK: - Helpers

    private static func distanceLabel(_ meters: Double) -> String {
        let miles = meters / 1609.34
        if miles >= 0.1 {
            return String(format: "%.1f mi", miles)
        }
        return "\(Int(meters * 3.28084)) ft"
    }

    private static func thresholdKey(for meters: Double) -> String {
        let miles = meters / 1609.34
        let thresholds: [(Double, String)] = [
            (2, "2mi"), (1, "1mi"), (0.5, "0.5mi"), (0.25, "0.25mi"),
            (200 / 1609.34, "200m"), (100 / 1609.34, "100m"),
        ]
        for (m, key) in thresholds where miles <= m {
            return key
        }
        return ""
    }

    static func voiceModifier(_ maneuver: String) -> String {
        switch maneuver.lowercased() {
        case "turn-left", "slight-left": return "turn left"
        case "turn-right", "slight-right": return "turn right"
        case "sharp-left": return "turn sharp left"
        case "sharp-right": return "turn sharp right"
        case "straight", "continue-straight": return "continue straight"
        case "fork-left", "fork-right": return "fork"
        case "merge": return "merge straight"
        case "roundabout-left", "roundabout-right": return "take the roundabout"
        case "exit-left", "exit-right": return "take the exit"
        case "on-ramp", "enter-highway-left", "enter-highway-right": return "take the on ramp"
        case "keep-left", "keep-right": return "keep"
        case "uturn", "uturn-left", "uturn-right": return "make a U-turn"
        case "arrive", "destination": return "arrive"
        case "depart": return "head"
        default: return "continue straight"
        }
    }

    static func classifyError(_ error: Error) -> String {
        if let ns = error as NSError?, ns.domain == NSURLErrorDomain {
            if ns.code == NSURLErrorTimedOut { return "This route took too long to load. Please try again." }
            return "No network connection. Please try again."
        }
        if let api = error as? APIError {
            switch api {
            case .server(let status, _):
                switch status {
                case 401, 403: return "Please sign in again."
                case 429: return "Too many requests. Please wait."
                case 404: return "No route found to this destination."
                default: return "We couldn't load this route. Please try again."
                }
            default:
                break
            }
        }
        return "We couldn't load this route. Please try again."
    }
}

/// Route progress calculator (mirrors route_progress_calculator.dart).
struct RouteProgress {
    var remainingMeters: Double
    var progressFraction: Double
    var currentStepIndex: Int
    var distanceToNextManeuver: Double?
    var etaSeconds: Double
}

enum RouteProgressCalculator {
    static func compute(gps: CLLocationCoordinate2D, polyline: [CLLocationCoordinate2D], steps: [RouteStep],
                        speedMps: Double, totalMeters: Double, snap: SnapResult?) -> RouteProgress {
        var remaining = totalMeters
        var currentStepIndex = 0

        if let snap {
            remaining = max(0, totalMeters - snap.alongMeters)
        } else {
            // Vertex-scan fallback
            var minDist = Double.greatestFiniteMagnitude
            for (idx, point) in polyline.enumerated() {
                let d = SpatialHash.haversine(gps, point)
                if d < minDist {
                    minDist = d
                    currentStepIndex = stepIndex(forMeters: pointIndexAlong(polyline, index: idx), cumulative: cumulativeStarts(steps))
                }
            }
        }

        let cumulative = cumulativeStarts(steps)
        currentStepIndex = stepIndex(forMeters: totalMeters - remaining, cumulative: cumulative)

        var distanceToNext: Double? = nil
        if steps.indices.contains(currentStepIndex) {
            let stepStart = cumulative[currentStepIndex]
            let stepLen = steps[currentStepIndex].distanceMeters
            let distanceToManeuver = remaining - (totalMeters - stepStart - stepLen)
            distanceToNext = max(0, distanceToManeuver)
        }

        let eta = remaining / max(speedMps, 5)
        let fraction = totalMeters > 0 ? min(max((totalMeters - remaining) / totalMeters, 0), 1) : 0
        return RouteProgress(remainingMeters: remaining, progressFraction: fraction,
                             currentStepIndex: currentStepIndex,
                             distanceToNextManeuver: distanceToNext,
                             etaSeconds: eta)
    }

    static func buildSteps(_ raw: [[String: Any]]) -> [RouteStep] {
        raw.map { RouteStep(json: $0) }
    }

    private static func cumulativeStarts(_ steps: [RouteStep]) -> [Double] {
        var result: [Double] = []
        var cursor = 0.0
        for step in steps {
            result.append(cursor)
            cursor += step.distanceMeters
        }
        return result
    }

    private static func stepIndex(forMeters meters: Double, cumulative: [Double]) -> Int {
        var idx = 0
        for (i, start) in cumulative.enumerated() where meters >= start {
            idx = i
        }
        return min(idx, max(cumulative.count - 1, 0))
    }

    private static func pointIndexAlong(_ polyline: [CLLocationCoordinate2D], index: Int) -> Double {
        var distance = 0.0
        guard index > 0, index < polyline.count else { return distance }
        for i in 1...index {
            distance += SpatialHash.haversine(polyline[i - 1], polyline[i])
        }
        return distance
    }
}

/// Route matcher (mirrors route_matcher.dart).
struct SnapResult {
    var point: CLLocationCoordinate2D
    var segmentIndex: Int
    var alongMeters: Double
    var distanceMeters: Double
    var segmentHeadingDeg: Double
}

final class RouteMatcher {
    private let polyline: [CLLocationCoordinate2D]
    private var cumulative: [Double] = []
    private var buckets: [Int: [Int]] = [:]
    private var lastSegment = 0
    private var lastSnap: SnapResult?

    init(route: [CLLocationCoordinate2D]) {
        self.polyline = route
        build()
    }

    private func build() {
        guard polyline.count >= 2 else { return }
        cumulative = [0]
        for i in 1..<polyline.count {
            cumulative.append(cumulative[i - 1] + SpatialHash.haversine(polyline[i - 1], polyline[i]))
        }
        for i in 0..<(polyline.count - 1) {
            let mid = CLLocationCoordinate2D(
                latitude: (polyline[i].latitude + polyline[i + 1].latitude) / 2,
                longitude: (polyline[i].longitude + polyline[i + 1].longitude) / 2
            )
            let key = bucketKey(mid)
            buckets[key, default: []].append(i)
        }
    }

    private func bucketKey(_ coord: CLLocationCoordinate2D) -> Int {
        let latCell = Int(coord.latitude / 0.001)
        let lngCell = Int(coord.longitude / 0.001)
        return (latCell << 16) ^ (lngCell & 0xffff)
    }

    func match(gps: CLLocationCoordinate2D, headingDeg: Double?) -> SnapResult? {
        guard polyline.count >= 2 else { return nil }
        var candidates: [Int] = []
        let key = bucketKey(gps)
        for dLat in -1...1 {
            for dLng in -1...1 {
                let k = ((Int(gps.latitude / 0.001) + dLat) << 16) ^ ((Int(gps.longitude / 0.001) + dLng) & 0xffff)
                candidates += buckets[k] ?? []
            }
        }
        if candidates.isEmpty {
            candidates = Array(max(0, lastSegment - 2)...min(polyline.count - 2, lastSegment + 2))
        }

        var best: (dist: Double, segment: Int, along: Double, point: CLLocationCoordinate2D, heading: Double)?
        for segment in Set(candidates) {
            guard segment >= 0, segment < polyline.count - 1 else { continue }
            let a = polyline[segment]
            let b = polyline[segment + 1]
            let projected = project(point: gps, a: a, b: b)
            let heading = bearing(a, b)
            let headingDelta = headingDeg.map { min(abs(angleDiff($0, heading)), 60) } ?? 0
            let segDelta = Double(abs(segment - lastSegment)) * 4
            let score = projected.distance + headingDelta * 0.5 + segDelta
            if best == nil || score < best!.dist {
                best = (score, segment, projected.along, projected.point, heading)
            }
        }

        guard let best else { return nil }
        // GPS jump guard
        if best.dist > 250, let last = lastSnap {
            return last
        }
        // Never move backward more than 20 m
        if let last = lastSnap, best.along < last.alongMeters - 20 {
            return last
        }
        let snap = SnapResult(point: best.point, segmentIndex: best.segment, alongMeters: best.along,
                              distanceMeters: best.dist, segmentHeadingDeg: best.heading)
        lastSnap = snap
        lastSegment = best.segment
        return snap
    }

    private func project(point p: CLLocationCoordinate2D, a: CLLocationCoordinate2D, b: CLLocationCoordinate2D) -> (point: CLLocationCoordinate2D, along: Double, distance: Double) {
        // Equirectangular meters
        let latRef = p.latitude.degreesToRadians
        let ax = a.longitude * cos(latRef) * 111320
        let ay = a.latitude * 111320
        let bx = b.longitude * cos(latRef) * 111320
        let by = b.latitude * 111320
        let px = p.longitude * cos(latRef) * 111320
        let py = p.latitude * 111320

        let dx = bx - ax
        let dy = by - ay
        let lenSq = dx * dx + dy * dy
        var t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0
        t = min(max(t, 0), 1)
        let cx = ax + t * dx
        let cy = ay + t * dy
        let dist = sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
        let along = SpatialHash.haversine(a, CLLocationCoordinate2D(latitude: cy / 111320, longitude: cx / (cos(latRef) * 111320)))
        return (CLLocationCoordinate2D(latitude: cy / 111320, longitude: cx / (cos(latRef) * 111320)), along, dist)
    }

    private func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let lat1 = a.latitude.degreesToRadians
        let lat2 = b.latitude.degreesToRadians
        let dLng = (b.longitude - a.longitude).degreesToRadians
        let y = sin(dLng) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
        let deg = atan2(y, x).radiansToDegrees
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    private func angleDiff(_ a: Double, _ b: Double) -> Double {
        let d = (a - b + 180).truncatingRemainder(dividingBy: 360) - 180
        return abs(d)
    }
}

/// Off-route detector with hysteresis (mirrors off_route_detector.dart).
final class OffRouteDetector {
    static let shared = OffRouteDetector()

    private let enterThresholdM = 80.0
    private let exitThresholdM = 30.0
    private let requiredTicks = 4
    private let headingAlignDeg = 45.0
    private let minSpeedMps = 1.2

    private var consecutiveTicks = 0
    private var wasOffRoute = false

    private init() {}

    func consider(snap: SnapResult, speed: Double, heading: Double, headingValid: Bool) -> Bool {
        let dev = snap.distanceMeters
        if dev <= exitThresholdM {
            consecutiveTicks = 0
            wasOffRoute = false
            return false
        }
        if dev <= enterThresholdM {
            return false
        }
        if speed < minSpeedMps {
            return false
        }
        let headingDelta = abs(Self.angleDiff(heading, snap.segmentHeadingDeg))
        let aligned = headingValid && headingDelta <= headingAlignDeg
        consecutiveTicks += 1
        let required = aligned ? requiredTicks * 2 : requiredTicks
        let fired = consecutiveTicks >= required && !wasOffRoute
        if fired {
            wasOffRoute = true
        }
        return fired
    }

    func reset() {
        consecutiveTicks = 0
        wasOffRoute = false
    }

    private static func angleDiff(_ a: Double, _ b: Double) -> Double {
        let d = (a - b + 180).truncatingRemainder(dividingBy: 360) - 180
        return abs(d)
    }
}

/// Reroute controller state machine (mirrors reroute_controller.dart, simplified).
final class RerouteController {
    enum Stage {
        case idle, localRecovery, backendRequest, cooldown
    }

    private var stage: Stage = .idle
    private var lastBackendAt: Date?
    private let cooldownInterval: TimeInterval = 20
    private let localRecoveryTimeout: TimeInterval = 10

    func onOffRoute(snap: SnapResult, position: CLLocationCoordinate2D, escalate: (Bool) -> Void) {
        if let last = lastBackendAt, Date().timeIntervalSince(last) < cooldownInterval {
            stage = .cooldown
            return
        }
        stage = .localRecovery
        DispatchQueue.main.asyncAfter(deadline: .now() + localRecoveryTimeout) { [weak self] in
            if self?.stage == .localRecovery {
                self?.stage = .backendRequest
                escalate(true)
                self?.lastBackendAt = Date()
            }
        }
    }

    func monitoring(offRoute: Bool, snap: SnapResult, position: CLLocationCoordinate2D) -> Bool {
        if stage == .localRecovery, snap.distanceMeters <= 30 {
            reset()
            return false
        }
        return offRoute
    }

    func reset() {
        stage = .idle
        lastBackendAt = nil
    }
}

/// Speed monitor (mirrors speed_monitor.dart, simplified).
final class SpeedMonitor {
    private(set) var speedMph: Double = 0
    private(set) var speedLimitMph: Double = 30
    private(set) var isSpeeding = false
    private(set) var roadName: String?
    private var limitMap: [String: Double] = [:]
    private let alpha = 0.4

    func start(route: NavigationRoute) {
        limitMap = route.speedLimitsByRoad ?? [:]
        speedLimitMph = limitMap.first?.value ?? 30
        roadName = limitMap.first?.key
        speedMph = 0
        isSpeeding = false
    }

    func update(speedMps: Double) {
        if speedMps > 60 {
            return // spike reject
        }
        let mph = speedMps * 2.23694
        speedMph = speedMph * (1 - alpha) + mph * alpha
        let freeway = isFreeway(roadName)
        let limit = speedLimitMph > 0 ? speedLimitMph : 30
        isSpeeding = speedMph > (freeway ? limit + 10 : limit)
    }

    func stop() {
        speedMph = 0
        isSpeeding = false
    }

    private func isFreeway(_ road: String?) -> Bool {
        guard let road else { return false }
        return road.range(of: #"\b(I-\d+|US-\d+|SR-\d+|CA-\d+|\bFwy\b|\bFreeway\b|\bInterstate\b|\bExpressway\b)"#,
                          options: .regularExpression) != nil
    }
}

/// Text-to-speech navigation voice (mirrors NavigationVoiceService).
final class NavigationVoiceService {
    static let instance = NavigationVoiceService()

    private let synthesizer = AVSpeechSynthesizer()

    private init() {
        synthesizer.delegate = nil
    }

    var isMuted: Bool {
        get { SessionStore.shared.voiceMuted }
        set { SessionStore.shared.voiceMuted = newValue }
    }

    func speak(_ text: String) {
        guard !isMuted else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = 0.5
        utterance.pitchMultiplier = 1.0
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }
}