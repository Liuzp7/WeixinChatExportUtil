#ifndef WIN32_UTIL_H
#define WIN32_UTIL_H

#include <Windows.h>
#include <string>

bool EnableDebugPrivilege();
std::string FormatWin32Error(const char* step, DWORD errorCode = 0);

#endif
