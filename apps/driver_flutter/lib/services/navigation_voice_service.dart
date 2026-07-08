import 'package:flutter/foundation.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';

class NavigationVoiceService {
  static final NavigationVoiceService instance = NavigationVoiceService._();
  NavigationVoiceService._();

  final FlutterTts _tts = FlutterTts();
  final ValueNotifier<bool> _muted = ValueNotifier<bool>(false);

  ValueListenable<bool> get mutedListenable => _muted;
  bool get muted => _muted.value;

  static const String _prefsKey = 'voice_muted';

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _muted.value = prefs.getBool(_prefsKey) ?? false;

    try {
      await _tts.setLanguage('en-US');
      await _tts.setSpeechRate(0.5);
      await _tts.setPitch(1.0);

      // Pick a female voice
      if (defaultTargetPlatform == TargetPlatform.iOS) {
        await _tts.setVoice({'name': 'Samantha', 'locale': 'en-US'});
      } else if (defaultTargetPlatform == TargetPlatform.android) {
        final dynamic voices = await _tts.getVoices;
        if (voices is List) {
          dynamic femaleVoice;
          for (final dynamic voice in voices) {
            if (voice is Map) {
              final name = voice['name']?.toString() ?? '';
              final locale = voice['locale']?.toString() ?? '';
              if (locale.contains('en-US') && name.toLowerCase().contains('female')) {
                femaleVoice = voice;
                break;
              }
            }
          }
          if (femaleVoice == null) {
            for (final dynamic voice in voices) {
              if (voice is Map) {
                final name = voice['name']?.toString() ?? '';
                if (name.toLowerCase().contains('female')) {
                  femaleVoice = voice;
                  break;
                }
              }
            }
          }
          if (femaleVoice != null && femaleVoice is Map) {
            await _tts.setVoice({
              'name': femaleVoice['name']?.toString() ?? '',
              'locale': femaleVoice['locale']?.toString() ?? '',
            });
          }
        }
      }
    } catch (e) {
      debugPrint('[NavigationVoiceService] Initialization failed: $e');
    }
  }

  Future<void> speak(String text) async {
    if (muted) return;
    try {
      await _tts.stop();
      await _tts.speak(text);
    } catch (e) {
      debugPrint('[NavigationVoiceService] speak failed: $e');
    }
  }

  Future<void> stop() async {
    try {
      await _tts.stop();
    } catch (e) {
      debugPrint('[NavigationVoiceService] stop failed: $e');
    }
  }

  Future<void> setMuted(bool value) async {
    if (_muted.value == value) return;
    _muted.value = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_prefsKey, value);
    if (value) {
      await stop();
    }
  }
}
