import SwiftUI
import MapKit
import CoreLocation

/// MapKit wrapper with ArcGIS branded tile overlay (mirrors driver map usage).
struct NetRideMapView: UIViewRepresentable {
    var markers: [MapMarker]
    var polyline: [CLLocationCoordinate2D]?
    var center: CLLocationCoordinate2D?
    var showsUserLocation = false
    var followMode = false
    var userHeading: Double? = nil
    var heatmapZones: [DemandZone] = []
    var onCameraChange: ((CLLocationCoordinate2D) -> Void)?

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.isRotateEnabled = false
        map.showsCompass = false
        map.showsUserLocation = showsUserLocation
        map.userTrackingMode = followMode ? .followWithHeading : .none

        let template = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
        let overlay = MKTileOverlay(urlTemplate: template)
        overlay.canReplaceMapContent = true
        map.addOverlay(overlay, level: .aboveLabels)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        map.removeAnnotations(map.annotations)
        for m in markers {
            map.addAnnotation(MapPinAnnotation(coordinate: m.coordinate, kind: m.kind, title: m.title))
        }
        map.removeOverlays(map.overlays.filter { !($0 is MKTileOverlay) })
        if let polyline, polyline.count >= 2 {
            map.addOverlay(MKPolyline(coordinates: polyline, count: polyline.count))
        }
        // Demand heat circles.
        for zone in heatmapZones {
            let circle = MKCircle(center: CLLocationCoordinate2D(latitude: zone.lat, longitude: zone.lng), radius: zone.radiusM)
            map.addOverlay(circle)
        }
        if let center {
            let current = map.centerCoordinate
            let moved = abs(current.latitude - center.latitude) > 0.0005
                || abs(current.longitude - center.longitude) > 0.0005
            if moved {
                let newRegion = MKCoordinateRegion(
                    center: center,
                    span: MKCoordinateSpan(latitudeDelta: 0.02, longitudeDelta: 0.02)
                )
                map.setRegion(newRegion, animated: true)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    class Coordinator: NSObject, MKMapViewDelegate {
        var parent: NetRideMapView
        init(_ parent: NetRideMapView) { self.parent = parent }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let tile = overlay as? MKTileOverlay {
                return MKTileOverlayRenderer(tileOverlay: tile)
            }
            if let line = overlay as? MKPolyline {
                let r = MKPolylineRenderer(polyline: line)
                r.strokeColor = UIColor(AppTheme.primaryBrandGreen)
                r.lineWidth = 7
                return r
            }
            if let circle = overlay as? MKCircle {
                let r = MKCircleRenderer(circle: circle)
                r.fillColor = UIColor(AppTheme.primaryBrandGreen.withOpacity(0.2))
                r.strokeColor = UIColor(AppTheme.primaryBrandGreen.withOpacity(0.5))
                r.lineWidth = 1
                return r
            }
            return MKOverlayRenderer(overlay: overlay)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            guard let pin = annotation as? MapPinAnnotation else { return nil }
            let identifier = "pin-\(pin.kind.rawValue)"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier) ?? MKAnnotationView()
            view.annotation = pin
            view.canShowCallout = false
            view.image = pin.kind.image
            return view
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            parent.onCameraChange?(mapView.centerCoordinate)
        }
    }
}

enum MapMarkerKind: String {
    case user, pickup, destination, driver, rider

    var image: UIImage? {
        switch self {
        case .user:
            return UIImage(systemName: "circle.fill")?.withTintColor(.systemBlue)
        case .pickup:
            return makeDot(UIColor(AppTheme.successGreen), size: 16)
        case .destination:
            return makeDot(UIColor(AppTheme.secondaryDarkText), size: 16)
        case .driver:
            return UIImage(systemName: "car.fill")?.withTintColor(UIColor(AppTheme.primaryBrandGreen))
        case .rider:
            return UIImage(systemName: "person.fill")?.withTintColor(UIColor(AppTheme.successGreen))
        }
    }
}

private func makeDot(_ color: UIColor, size: CGFloat) -> UIImage? {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
    return renderer.image { ctx in
        color.setFill()
        ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
    }
}

struct MapMarker: Identifiable {
    let id = UUID()
    var coordinate: CLLocationCoordinate2D
    var kind: MapMarkerKind
    var title: String?
}

final class MapPinAnnotation: NSObject, MKAnnotation {
    var coordinate: CLLocationCoordinate2D
    var kind: MapMarkerKind
    var title: String?
    init(coordinate: CLLocationCoordinate2D, kind: MapMarkerKind, title: String? = nil) {
        self.coordinate = coordinate
        self.kind = kind
        self.title = title
    }
}