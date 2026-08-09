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
  final String? documentType;
  final String? requirementId;

  const DriverStatusCard({
    super.key,
    required this.state,
    this.rejectionReason,
    this.onAction,
    this.onDismiss,
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
          color: AppTheme.successGreen,
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

      case DriverStatusKind.readyToDrive:
        return _build(
          color: AppTheme.successGreen,
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
          color: AppTheme.successGreen,
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
          title: 'Action required: headshot photo',
          message: 'A headshot photo check is required before you can go online.',
          actionLabel: 'UPDATE',
          onAction: onAction,
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

/// What the card should communicate.
enum DriverStatusKind {
  backgroundPending,
  backgroundApproved,
  backgroundRejected,
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

  const DriverStatus._(this.kind);

  static const backgroundPending = DriverStatus._(DriverStatusKind.backgroundPending);
  static const backgroundApproved = DriverStatus._(DriverStatusKind.backgroundApproved);
  static const backgroundRejected = DriverStatus._(DriverStatusKind.backgroundRejected);
  static const readyToDrive = DriverStatus._(DriverStatusKind.readyToDrive);
  static const profileChangePending = DriverStatus._(DriverStatusKind.profileChangePending);
  static const profileChangeApproved = DriverStatus._(DriverStatusKind.profileChangeApproved);
  static const documentActionRequired = DriverStatus._(DriverStatusKind.documentActionRequired);
  static const vehicleInspectionRequired = DriverStatus._(DriverStatusKind.vehicleInspectionRequired);
  static const documentSubmittedForReview = DriverStatus._(DriverStatusKind.documentSubmittedForReview);
  static const headshotActionRequired = DriverStatus._(DriverStatusKind.headshotActionRequired);
}