// Native contact picker + SMS composer.
//
// The native picker is used deliberately instead of reading the address book:
// the OS hands us ONLY the contact the rider explicitly selected. No contact
// list is ever uploaded to NetRide.

import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_contacts/flutter_contacts.dart';
import 'package:url_launcher/url_launcher.dart';

class PickedContact {
  final String? id;
  final String name;
  final String phone;
  const PickedContact({this.id, required this.name, required this.phone});
}

class ContactPickerException implements Exception {
  final String message;
  const ContactPickerException(this.message);
  @override
  String toString() => message;
}

class ContactInviteService {
  ContactInviteService._();

  /// Opens the OS contact picker. Requests read access only when the platform
  /// requires it to return the selected phone number.
  static Future<PickedContact?> pickOne() async {
    try {
      final contact = await FlutterContacts.native.showPicker(
        properties: const {ContactProperty.phone},
      );
      return _fromContact(contact);
    } on PlatformException catch (e) {
      if (e.code == 'permission_denied' || e.code.contains('permission')) {
        return _pickWithPermission();
      }
      if (kDebugMode) debugPrint('[CONTACTS] native picker failed: $e');
      throw const ContactPickerException(
        'We could not open your contacts. You can enter the phone number manually.',
      );
    } on MissingPluginException {
      throw const ContactPickerException(
        'Contact selection is not available on this device. Enter the phone number manually.',
      );
    }
  }

  static Future<PickedContact?> _pickWithPermission() async {
    final status = await FlutterContacts.permissions.request(
      PermissionType.read,
    );
    if (status != PermissionStatus.granted &&
        status != PermissionStatus.limited) {
      throw const ContactPickerException(
        'Contact access was denied. You can enter the phone number manually.',
      );
    }
    final contact = await FlutterContacts.native.showPicker(
      properties: const {ContactProperty.phone},
    );
    return _fromContact(contact);
  }

  static PickedContact? _fromContact(Contact? contact) {
    if (contact == null) return null;
    final phones = contact.phones
        .map((p) => p.number.trim())
        .where((p) => p.replaceAll(RegExp(r'\D'), '').length >= 7)
        .toList();
    if (phones.isEmpty) {
      throw const ContactPickerException(
        'That contact has no phone number. Choose another contact or enter the number manually.',
      );
    }
    return PickedContact(
      id: contact.id,
      name: (contact.displayName ?? '').trim().isEmpty
          ? 'Friend'
          : contact.displayName!.trim(),
      phone: phones.first,
    );
  }

  /// Opens the native SMS composer pre-filled with the invitation. The user
  /// always reviews and sends it explicitly.
  static Future<bool> openSmsComposer({
    required String phone,
    required String message,
  }) async {
    final clean = phone.replaceAll(RegExp(r'\s+'), '');
    final encoded = Uri.encodeComponent(message);
    final uri = Platform.isIOS
        ? Uri.parse('sms:$clean&body=$encoded')
        : Uri.parse('sms:$clean?body=$encoded');
    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!launched) {
      // Some Android devices only accept smsto:.
      if (!Platform.isIOS) {
        final fallback = await launchUrl(
          Uri.parse('smsto:$clean?body=$encoded'),
          mode: LaunchMode.externalApplication,
        );
        return fallback;
      }
      return false;
    }
    return true;
  }

  static String groupInviteMessage({
    required String inviterName,
    required String groupName,
    required String inviteUrl,
  }) {
    return 'Hey! $inviterName invited you to "$groupName" on NetRide. '
        "We're organizing a group ride so we can coordinate pickups and split the fare. "
        'Join here: $inviteUrl';
  }

  static String referralInviteMessage({
    required String inviterName,
    required String referralCode,
    required String referralUrl,
    String? downloadUrl,
  }) {
    final download = (downloadUrl != null && downloadUrl.trim().isNotEmpty)
        ? '\n\nDownload NetRide: ${downloadUrl.trim()}'
        : '';
    return 'Hey! $inviterName here. Join me on NetRide — use my referral code '
        '$referralCode and we both get ride credits. '
        'Open: $referralUrl$download';
  }
}
