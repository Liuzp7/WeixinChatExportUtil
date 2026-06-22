#include "../include/win32_util.h"

#include <sstream>

bool EnableDebugPrivilege() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token)) {
    return false;
  }

  LUID luid{};
  if (!LookupPrivilegeValueW(nullptr, SE_DEBUG_NAME, &luid)) {
    CloseHandle(token);
    return false;
  }

  TOKEN_PRIVILEGES tp{};
  tp.PrivilegeCount = 1;
  tp.Privileges[0].Luid = luid;
  tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  AdjustTokenPrivileges(token, FALSE, &tp, sizeof(tp), nullptr, nullptr);

  DWORD err = GetLastError();
  CloseHandle(token);
  return err == ERROR_SUCCESS;
}

std::string FormatWin32Error(const char* step, DWORD errorCode) {
  if (errorCode == 0) {
    errorCode = GetLastError();
  }

  std::ostringstream oss;
  oss << step;
  if (errorCode != 0) {
    oss << " (Win32 " << errorCode << ')';
    LPWSTR buffer = nullptr;
    DWORD length = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                                      FORMAT_MESSAGE_IGNORE_INSERTS,
                                  nullptr, errorCode, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
                                  reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
    if (length && buffer) {
      std::wstring wide(buffer, length);
      while (!wide.empty() && (wide.back() == L'\r' || wide.back() == L'\n')) {
        wide.pop_back();
      }
      if (!wide.empty()) {
        int sizeNeeded = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                                             nullptr, 0, nullptr, nullptr);
        if (sizeNeeded > 0) {
          std::string utf8(sizeNeeded, 0);
          WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), utf8.data(),
                              sizeNeeded, nullptr, nullptr);
          oss << ": " << utf8;
        }
      }
      LocalFree(buffer);
    }
  }
  return oss.str();
}
