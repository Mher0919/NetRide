#include "utils.h"

#include <flutter_windows.h>
#include <io.h>
#include <stdio.h>
#include <windows.h>

#include <iostream>
#include <string>
#include <vector>

void CreateAndAttachConsole() {
  if (::AllocConsole()) {
    FILE *unused;
    if (freopen_s(&unused, "CONOUT$", "w", stdout)) {
      _dup2(_fileno(stdout), 1);
    }
    if (freopen_s(&unused, "CONOUT$", "w", stderr)) {
      _dup2(_fileno(stdout), 2);
    }
    std::ios::sync_with_stdio();
    FlutterDesktopResyncOutputStreams();
  }
}

std::vector<std::string> GetCommandLineArguments() {
  // Convert the UTF-16 command line arguments to UTF-8 for the Engine to use.
  int argc;
  wchar_t** argv = ::CommandLineToArgvW(::GetCommandLineW(), &argc);
  if (argv == nullptr) {
    return std::vector<std::string>();
  }

  std::vector<std::string> command_line_arguments;

  // Skip the first argument as it's the binary name.
  for (int i = 1; i < argc; i++) {
    command_line_arguments.push_back(Utf8FromUtf16(argv[i]));
  }

  ::LocalFree(argv);

  return command_line_arguments;
}

std::string Utf8FromUtf16(const wchar_t* utf16_string) {
  if (utf16_string == nullptr) {
    return std::string();
  }
  unsigned int target_length = ::WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, utf16_string,
      -1, nullptr, 0, nullptr, nullptr)
    -1; // remove the trailing null character
  int input_length = (int)wcslen(utf16_string);
  std::string utf8_string;
  if (target_length == 0 || target_length > utf8_string.max_size()) {
    return utf8_string;
  }
  utf8_string.resize(target_length);
  int converted_length = ::WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, utf16_string,
      input_length, utf8_string.data(), target_length, nullptr, nullptr);
  if (converted_length == 0) {
    return std::string();
  }
  return utf8_string;
}

void RegisterUriScheme() {
  const wchar_t* scheme = L"io.supabase.netride";
  const wchar_t* appPath = nullptr;
  wchar_t exePath[MAX_PATH];
  if (GetModuleFileNameW(nullptr, exePath, MAX_PATH) > 0) {
    appPath = exePath;
  }

  HKEY hKey;
  // Create the scheme key
  std::wstring schemeKey = L"SOFTWARE\\Classes\\" + std::wstring(scheme);
  LONG result = RegCreateKeyExW(HKEY_CURRENT_USER, schemeKey.c_str(), 0,
                                nullptr, REG_OPTION_NON_VOLATILE, KEY_WRITE,
                                nullptr, &hKey, nullptr);
  if (result == ERROR_SUCCESS) {
    // Set the URL Protocol
    const wchar_t* urlProtocol = L"URL Protocol";
    RegSetValueExW(hKey, urlProtocol, 0, REG_SZ, (const BYTE*)L"", 2);

    // Set the default icon
    std::wstring defaultIconKey = schemeKey + L"\\DefaultIcon";
    HKEY hIconKey;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, defaultIconKey.c_str(), 0, nullptr,
                        REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &hIconKey,
                        nullptr) == ERROR_SUCCESS) {
      if (appPath) {
        std::wstring iconValue = std::wstring(appPath) + L",1";
        RegSetValueExW(hIconKey, nullptr, 0, REG_SZ,
                       (const BYTE*)iconValue.c_str(),
                       (DWORD)((iconValue.size() + 1) * sizeof(wchar_t)));
      }
      RegCloseKey(hIconKey);
    }

    // Set the shell open command
    std::wstring commandKey = schemeKey + L"\\shell\\open\\command";
    HKEY hCommandKey;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, commandKey.c_str(), 0, nullptr,
                        REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &hCommandKey,
                        nullptr) == ERROR_SUCCESS) {
      if (appPath) {
        std::wstring commandValue = L"\"" + std::wstring(appPath) + L"\" \"%1\"";
        RegSetValueExW(hCommandKey, nullptr, 0, REG_SZ,
                       (const BYTE*)commandValue.c_str(),
                       (DWORD)((commandValue.size() + 1) * sizeof(wchar_t)));
      }
      RegCloseKey(hCommandKey);
    }
  }
}
