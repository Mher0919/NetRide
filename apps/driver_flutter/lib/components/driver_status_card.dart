import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../theme/app_theme.dart';

/// Palette-aligned status banner that replaces the old `VerificationBanner`
/// for the driver map screen.
///
/// Renders one of:
///   - background-check pending (terracotta)
///   - background-check approved first time (sage, dismissible)
///   - background-check rejected (terracotta, with feedback link)
///   - face-check required (terracotta, action required)
///   - face-check flagged, awaiting admin review (terracotta)
///   - face-check passed this session (sage)
///   - all clear, ready to drive (sage)
///   - document resubmission required (terracotta, document-specific)
///   - vehicle inspection required (terracotta)
///   - profile change pending (terracotta)
///   - headshot action required (terracotta)
class DriverStatusCard extends StatelessWidget {
  final DriverStatus state;
  final String? rejectionReason;
  final VoidCallback? onAction;
  final VoidCallback? onDismiss;
  final VoidCallback? onStartFaceCheck;
  final String? documentType;
  final String? requirementId;

  const DriverStatusCard({
    super.key,
    required this.state,
    this.rejectionReason,
    this.onAction,
    this.onDismiss,
    this.onStartFaceCheck,
    this.documentType,
    this.requirementId,
  });

  @override
  Widget build(BuildContext context) {
    switch (state.kind) {
      case DriverStatusKind.backgroundPending:
        return _build(
          color: AppTheme.errorColor,
          icon: Icons.hourglass_empty_rounded,
          title: 'Background check in progress',
          message:
              'We\'re reviewing your documents. You\'ll be able to drive once it\'s approved.',
        );

      case DriverStatusKind.backgroundApproved:
        return _build(
          color: AppTheme.primaryBrandGreen,
          icon: Icons.check_circle_outline_rounded,
          title: 'Background check approved!',
          message: 'You are now authorized to drive.',
          dismissible: true,
          onDismiss: onDismiss,
        );

      case DriverStatusKind.backgroundRejected:
        return _build(
          color: AppTheme.errorColor,
          icon: Icons.error_outline_rounded,
          title: 'Application rejected',
          message: rejectionReason ?? 'Please review the administrator feedback.',
          actionLabel: 'SEE WHY',
          onAction: onAction,
        );

      case DriverStatusKind.faceRequired:
        return _build(
          color: AppTheme.errorColor,
          icon: Icons.face_retouching_natural,
          title: 'Action required: face verification',
          message: _faceMessage(state.faceReason),
          actionLabel: 'START',
          onAction: onStartFaceCheck,
        );

      case DriverStatusKind.faceFlagged:
        return _build(
          color: AppTheme.errorColor,
          icon: Icons.priority_high_rounded,
          title: 'Account flagged for review',
          message:
              'Your last face check didn\'t match. Our team is reviewing — please wait.',
        );

      case DriverStatusKind.facePassed:
        return _build(
          color: AppTheme.successGreen,
          icon: Icons.verified_user_rounded,
          title: 'Face check passed',
          message: 'You\'re cleared to drive. We\'ll re-verify every 12 hours.',
        );

      case DriverStatusKind.readyToDrive:
        return _build(
          color: AppTheme.primaryBrandGreen,
          icon: Icons.local_taxi_rounded,
          title: 'You can now drive!',
          message: 'Flip the switch below to start accepting ride requests.',
        );

      case DriverStatusKind.profileChangePending:
        return _build(
          color: AppTheme.errorColor,
          icon: Icons.pending_actions_rounded,
          title: 'Profile change under review',
          message:
              'You won\'t be able to go online until an admin approves your requested changes.',
          actionLabel: 'VIEW DETAILS',
          onAction: onAction,
        );

      case DriverStatusKind.profileChangeApproved:
        return _build(
          color: AppTheme.primaryBrandGreen,
          icon: Icons.check_circle_outline_rounded,
          title: 'Changes approved — you\'re cleared to drive!',
          message:
              'Your profile updates are live. Flip the switch below to start accepting ride requests.',
          dismissible: true,
          onDismiss: onDismiss,
        );

      case DriverStatusKind.documentActionRequired:
        return _buildDocumentActionRequired();

      case DriverStatusKind.documentSubmittedForReview:
        return _build(
          color: AppTheme.warningColor,
          icon: Icons.hourglass_bottom_rounded,
          title: 'Document resubmitted',
          message: 'Your updated document is being reviewed. We\'ll let you know once it\'s approved.',
        );

      case DriverStatusKind.headshotActionRequired:
        return _build(
          color: AppTheme.errorColor,
          icon: Icons.face_retouching_natural,
          title: 'Action required: face verification',
          message: 'Headshot photo check required',
          actionLabel: 'START',
          onAction: onStartFaceCheck,
        );

      case DriverStatusKind.vehicleInspectionRequired:
        return _build(
          color: AppTheme.errorColor,
          icon: Icons.directions_car_rounded,
          title: 'Action required: vehicle inspection',
          message: 'A certified vehicle inspection is required before you can drive.',
          actionLabel: 'VIEW',
          onAction: onAction,
        );
    }
  }

  Widget _buildDocumentActionRequired() {
    if (documentType == null) {
      return _build(
        color: AppTheme.errorColor,
        icon: Icons.description_outlined,
        title: 'Action required: documents',
        message: 'An admin has requested updated documents. Please review and resubmit.',
        actionLabel: 'VIEW',
        onAction: onAction,
      );
    }
    final docInfo = _getDocumentInfo(documentType!);
    return _build(
      color: AppTheme.errorColor,
      icon: docInfo.icon,
      title: 'Action required: ${docInfo.title}',
      message: 'An admin has requested an updated ${docInfo.title.toLowerCase()}. Please review and resubmit.',
      actionLabel: 'VIEW',
      onAction: onAction,
    );
  }

  _DocumentInfo _getDocumentInfo(String docType) {
    switch (docType) {
      case 'license_photo_url':
        return _DocumentInfo('Driver License (Front)', Icons.badge_outlined);
      case 'license_photo_back_url':
        return _DocumentInfo('Driver License (Back)', Icons.badge_outlined);
      case 'insurance_photo_url':
        return _DocumentInfo('Insurance Document', Icons.verified_outlined);
      case 'registration_photo_url':
        return _DocumentInfo('Vehicle Registration', Icons.description_outlined);
      case 'inspection_photo_url':
        return _DocumentInfo('Vehicle Inspection', Icons.directions_car_rounded);
      case 'id_photo_front_url':
        return _DocumentInfo('ID Card (Front)', Icons.credit_card_outlined);
      case 'id_photo_back_url':
        return _DocumentInfo('ID Card (Back)', Icons.credit_card_outlined);
      default:
        return _DocumentInfo('Document', Icons.description_outlined);
    }
  }

  String _faceMessage(String? reason) {
    switch (reason) {
      case 'flagged':
        return 'Your last check failed — please retake it now.';
      case 'enrollment':
        return 'We need to capture your face to enroll you in our system.';
      case 'first_time':
        return 'First-time setup: please complete your face enrollment.';
      case '12h_expired':
        return 'It\'s been more than 12 hours since your last face check.';
      case 'new_device':
        return 'We noticed a new device. Please re-verify.';
      case 'location_jump':
        return 'You\'re more than 5 miles from your last offline location — please re-verify.';
      default:
        return 'A quick face check is needed before you can go online.';
    }
  }

  Widget _build({
    required Color color,
    required IconData icon,
    required String title,
    required String message,
    String? actionLabel,
    VoidCallback? onAction,
    bool dismissible = false,
    VoidCallback? onDismiss,
  }) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16).copyWith(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.08),
            blurRadius: 8,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.2),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: Colors.white, size: 20),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: GoogleFonts.inter(
                    color: Colors.white,
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  message,
                  style: GoogleFonts.inter(
                    color: Colors.white.withOpacity(0.9),
                    fontSize: 12,
                    fontWeight: FontWeight.w400,
                    height: 1.3,
                  ),
                ),
              ],
            ),
          ),
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(width: 8),
            TextButton(
              onPressed: onAction,
              style: TextButton.styleFrom(
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                side: const BorderSide(color: Colors.white, width: 1),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              child: Text(
                actionLabel,
                style: GoogleFonts.inter(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.5,
                ),
              ),
            ),
          ],
          if (dismissible) ...[
            const SizedBox(width: 4),
            IconButton(
              onPressed: onDismiss,
              icon: const Icon(Icons.close, color: Colors.white, size: 18),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
            ),
          ],
        ],
      ),
    );
  }
}

class _DocumentInfo {
  final String title;
  final IconData icon;

  _DocumentInfo(this.title, this.icon);
}

/// What the card should communicate. `faceReason` mirrors the backend's
/// reason enum (`flagged`, `enrollment`, `first_time`, `12h_expired`,
/// `new_device`, `location_jump`).
enum DriverStatusKind {
  backgroundPending,
  backgroundApproved,
  backgroundRejected,
  faceRequired,
  faceFlagged,
  facePassed,
  readyToDrive,
  profileChangePending,
  profileChangeApproved,
  documentActionRequired,
  vehicleInspectionRequired,
  documentSubmittedForReview,
  headshotActionRequired,
}

class DriverStatus {
  final DriverStatusKind kind;
  final String? faceReason;

  const DriverStatus._(this.kind, this.faceReason);

  static const backgroundPending = DriverStatus._(DriverStatusKind.backgroundPending, null);
  static const backgroundApproved = DriverStatus._(DriverStatusKind.backgroundApproved, null);
  static const backgroundRejected = DriverStatus._(DriverStatusKind.backgroundRejected, null);
  static const faceFlagged = DriverStatus._(DriverStatusKind.faceFlagged, null);
  static const facePassed = DriverStatus._(DriverStatusKind.facePassed, null);
  static const readyToDrive = DriverStatus._(DriverStatusKind.readyToDrive, null);
  static const profileChangePending = DriverStatus._(DriverStatusKind.profileChangePending, null);
  static const profileChangeApproved = DriverStatus._(DriverStatusKind.profileChangeApproved, null);
  static const documentActionRequired = DriverStatus._(DriverStatusKind.documentActionRequired, null);
  static const vehicleInspectionRequired = DriverStatus._(DriverStatusKind.vehicleInspectionRequired, null);
  static const documentSubmittedForReview = DriverStatus._(DriverStatusKind.documentSubmittedForReview, null);
  static const headshotActionRequired = DriverStatus._(DriverStatusKind.headshotActionRequired, null);

  factory DriverStatus.faceRequired(String reason) =>
      DriverStatus._(DriverStatusKind.faceRequired, reason);
}