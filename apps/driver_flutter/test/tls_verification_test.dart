// apps/driver_flutter/test/tls_verification_test.dart
//
// Platform TLS verification regression (security finding D).
//
// The app must rely on standard certificate-chain + hostname verification
// (dart:io HttpClient / OkHttp / ATS defaults). This test exercises dart:io
// against a controlled local TLS server and asserts:
//   * valid, trusted, matching certificate  -> accepted
//   * untrusted (self-signed) chain         -> rejected
//   * hostname mismatch                     -> rejected
//   * expired certificate                   -> rejected (OpenSSL >= 3.2)
//
// The repository-wide scan for TLS-bypass code (badCertificateCallback,
// custom trust managers, ...) lives in tests/security/run-security-checks.cjs.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String? _opensslPath;
Directory? _fixtureDir;
String? _keyPath;
String? _certPath;

String _openssl(List<String> args) {
  final result = Process.runSync(_opensslPath!, args);
  if (result.exitCode != 0) {
    fail('openssl ${args.first} failed: ${result.stderr}');
  }
  return result.stdout.toString();
}

/// Generates a self-signed cert for [cn] valid until [notAfter] (default 2
/// days) with SAN DNS:localhost only — deliberately no IP SAN so a mismatch
/// case can be exercised via 127.0.0.1.
void _generateCert({bool expired = false}) {
  final subjectAltName = 'DNS:localhost';
  final dateArgs = expired
      ? [
          '-not_before', '20200101000000Z',
          '-not_after', '20200102000000Z',
        ]
      : ['-days', '2'];
  _openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', _keyPath!,
    '-out', _certPath!,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=$subjectAltName',
    ...dateArgs,
  ]);
}

void main() {
  setUpAll(() {
    final which = Process.runSync(
      Platform.isWindows ? 'where' : 'which',
      ['openssl'],
    );
    if (which.exitCode != 0) {
      _opensslPath = null;
      return;
    }
    _opensslPath = which.stdout.toString().trim().split(RegExp(r'\r?\n')).first;

    _fixtureDir = Directory.systemTemp.createTempSync('netride-tls-');
    _keyPath = '${_fixtureDir!.path}/key.pem';
    _certPath = '${_fixtureDir!.path}/cert.pem';
  });

  tearDownAll(() {
    if (_fixtureDir != null && _fixtureDir!.existsSync()) {
      _fixtureDir!.deleteSync(recursive: true);
    }
  });

  test('TLS: standard verification accepts a trusted, matching certificate',
      () async {
    if (_opensslPath == null) {
      markTestSkipped('openssl not available');
      return;
    }
    _generateCert();

    final context = SecurityContext()
      ..useCertificateChain(_certPath!)
      ..usePrivateKey(_keyPath!);
    final server = await SecureServerSocket.bind('127.0.0.1', 0, context);
    server.listen((socket) {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      socket.close();
    });

    try {
      final client = HttpClient(context: SecurityContext()..setTrustedCertificates(_certPath!));
      final request = await client.getUrl(
        Uri.parse('https://localhost:${server.port}/'),
      );
      final response = await request.close();
      expect(response.statusCode, 200);
      client.close(force: true);
    } finally {
      await server.close();
    }
  });

  test('TLS: an untrusted (self-signed) chain is rejected', () async {
    if (_opensslPath == null) {
      markTestSkipped('openssl not available');
      return;
    }
    _generateCert();

    final context = SecurityContext()
      ..useCertificateChain(_certPath!)
      ..usePrivateKey(_keyPath!);
    final server = await SecureServerSocket.bind('127.0.0.1', 0, context);
    server.listen((socket) {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      socket.close();
    });

    try {
      final client = HttpClient(); // default trust store
      await expectLater(
        client.getUrl(Uri.parse('https://localhost:${server.port}/')),
        throwsA(isA<HandshakeException>()),
      );
      client.close(force: true);
    } finally {
      await server.close();
    }
  });

  test('TLS: a hostname mismatch is rejected even for a trusted certificate',
      () async {
    if (_opensslPath == null) {
      markTestSkipped('openssl not available');
      return;
    }
    _generateCert(); // SAN: DNS:localhost only — no IP SAN

    final context = SecurityContext()
      ..useCertificateChain(_certPath!)
      ..usePrivateKey(_keyPath!);
    final server = await SecureServerSocket.bind('127.0.0.1', 0, context);
    server.listen((socket) {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      socket.close();
    });

    try {
      final client = HttpClient(context: SecurityContext()..setTrustedCertificates(_certPath!));
      await expectLater(
        client.getUrl(Uri.parse('https://127.0.0.1:${server.port}/')),
        throwsA(isA<HandshakeException>()),
      );
      client.close(force: true);
    } finally {
      await server.close();
    }
  });

  test('TLS: an expired certificate is rejected', () async {
    if (_opensslPath == null) {
      markTestSkipped('openssl not available');
      return;
    }
    final versionOutput = _openssl(['version']);
    final match = RegExp(r'OpenSSL (\d+)\.(\d+)').firstMatch(versionOutput);
    final major = int.tryParse(match?.group(1) ?? '') ?? 0;
    final minor = int.tryParse(match?.group(2) ?? '') ?? 0;
    if (major < 3 || (major == 3 && minor < 2)) {
      markTestSkipped('openssl >= 3.2 required for explicit not_before/not_after');
      return;
    }

    _generateCert(expired: true);

    final context = SecurityContext()
      ..useCertificateChain(_certPath!)
      ..usePrivateKey(_keyPath!);
    final server = await SecureServerSocket.bind('127.0.0.1', 0, context);
    server.listen((socket) {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      socket.close();
    });

    try {
      final client = HttpClient(context: SecurityContext()..setTrustedCertificates(_certPath!));
      await expectLater(
        client.getUrl(Uri.parse('https://localhost:${server.port}/')),
        throwsA(isA<HandshakeException>()),
      );
      client.close(force: true);
    } finally {
      await server.close();
    }
  });
}
