#include "../include/remote_scanner.h"

#include <array>
#include <sstream>
#include <algorithm>

#pragma comment(lib, "Psapi.lib")
#pragma comment(lib, "version.lib")

std::vector<WeChatVersionConfig> VersionConfigManager::configs;
bool VersionConfigManager::initialized = false;

namespace {

using VersionArray = std::array<int, 4>;

bool ParseVersionString(const std::string& version, VersionArray& outParts) {
  outParts.fill(0);
  std::stringstream ss(version);
  std::string segment;
  size_t index = 0;
  while (std::getline(ss, segment, '.') && index < outParts.size()) {
    try {
      outParts[index++] = std::stoi(segment);
    } catch (...) {
      return false;
    }
  }
  return index > 0;
}

int CompareVersions(const VersionArray& lhs, const VersionArray& rhs) {
  for (size_t i = 0; i < lhs.size(); ++i) {
    if (lhs[i] < rhs[i]) return -1;
    if (lhs[i] > rhs[i]) return 1;
  }
  return 0;
}

}  // namespace

void VersionConfigManager::InitializeConfigs() {
  if (initialized) return;

  configs.push_back(WeChatVersionConfig{
      ">4.1.6.14",
      {0x24, 0x50, 0x48, 0xC7, 0x45, 0x00, 0xFE, 0xFF, 0xFF, 0xFF, 0x44, 0x89, 0xCF, 0x44, 0x89, 0xC3,
       0x49, 0x89, 0xD6, 0x48, 0x89, 0xCE, 0x48, 0x89},
      "xxxxxxxxxxxxxxxxxxxxxxxx",
      -3});

  configs.push_back(WeChatVersionConfig{
      ">=4.1.4 && <=4.1.6.14",
      {0x24, 0x08, 0x48, 0x89, 0x6c, 0x24, 0x10, 0x48, 0x89, 0x74, 0x00, 0x18, 0x48, 0x89, 0x7c, 0x00,
       0x20, 0x41, 0x56, 0x48, 0x83, 0xec, 0x50, 0x41},
      "xxxxxxxxxx?xxxx?xxxxxxxx",
      -3});

  configs.push_back(WeChatVersionConfig{
      "<4.1.4",
      {0x24, 0x50, 0x48, 0xc7, 0x45, 0x00, 0xfe, 0xff, 0xff, 0xff, 0x44, 0x89, 0xcf, 0x44, 0x89, 0xc3,
       0x49, 0x89, 0xd6, 0x48, 0x89, 0xce, 0x48, 0x89},
      "xxxxxxxxxxxxxxxxxxxxxxxx",
      -0xf});

  initialized = true;
}

const WeChatVersionConfig* VersionConfigManager::GetConfigForVersion(const std::string& version) {
  InitializeConfigs();
  if (configs.size() < 3 || version.empty()) return nullptr;

  VersionArray parsedVersion;
  if (!ParseVersionString(version, parsedVersion)) return nullptr;

  constexpr VersionArray baseline414 = {4, 1, 4, 0};
  constexpr VersionArray baseline41614 = {4, 1, 6, 14};

  if (CompareVersions(parsedVersion, baseline41614) > 0) return &configs[0];
  if (CompareVersions(parsedVersion, baseline414) >= 0 &&
      CompareVersions(parsedVersion, baseline41614) <= 0) {
    return &configs[1];
  }
  if ((parsedVersion[0] == 4 && parsedVersion[1] == 1 && parsedVersion[2] < 4) ||
      (parsedVersion[0] == 4 && parsedVersion[1] == 0)) {
    return &configs[2];
  }
  return nullptr;
}

RemoteScanner::RemoteScanner(HANDLE hProcess) : hProcess(hProcess) {
  scanBuffer.reserve(2 * 1024 * 1024);
}

bool RemoteScanner::GetRemoteModuleInfo(const std::string& moduleName, RemoteModuleInfo& outInfo) {
  HMODULE hMods[1024];
  DWORD cbNeeded;
  if (!EnumProcessModules(hProcess, hMods, sizeof(hMods), &cbNeeded)) return false;

  DWORD moduleCount = cbNeeded / sizeof(HMODULE);
  for (DWORD i = 0; i < moduleCount; i++) {
    char szModName[MAX_PATH];
    if (!GetModuleBaseNameA(hProcess, hMods[i], szModName, sizeof(szModName))) continue;
    if (_stricmp(szModName, moduleName.c_str()) != 0) continue;

    MODULEINFO modInfo{};
    if (!GetModuleInformation(hProcess, hMods[i], &modInfo, sizeof(modInfo))) continue;
    outInfo.baseAddress = hMods[i];
    outInfo.imageSize = modInfo.SizeOfImage;
    outInfo.moduleName = szModName;
    return true;
  }
  return false;
}

bool RemoteScanner::MatchPattern(const BYTE* data, const BYTE* pattern, const char* mask, size_t length) {
  for (size_t i = 0; i < length; i++) {
    if (mask[i] != '?' && data[i] != pattern[i]) return false;
  }
  return true;
}

std::vector<uintptr_t> RemoteScanner::FindAllPatterns(const RemoteModuleInfo& moduleInfo,
                                                      const BYTE* pattern, const char* mask) {
  std::vector<uintptr_t> results;
  size_t patternLength = strlen(mask);
  uintptr_t baseAddress = reinterpret_cast<uintptr_t>(moduleInfo.baseAddress);
  SIZE_T imageSize = moduleInfo.imageSize;
  const SIZE_T CHUNK_SIZE = 1024 * 1024;

  scanBuffer.resize(CHUNK_SIZE + patternLength);
  for (SIZE_T offset = 0; offset < imageSize; offset += CHUNK_SIZE) {
    SIZE_T readSize = (std::min)(CHUNK_SIZE + patternLength, imageSize - offset);
    SIZE_T bytesRead = 0;
    if (!ReadProcessMemory(hProcess, reinterpret_cast<PVOID>(baseAddress + offset), scanBuffer.data(),
                           readSize, &bytesRead) ||
        bytesRead < patternLength) {
      continue;
    }

    for (SIZE_T i = 0; i + patternLength <= bytesRead; ++i) {
      if (MatchPattern(&scanBuffer[i], pattern, mask, patternLength)) {
        results.push_back(baseAddress + offset + i);
      }
    }
  }
  return results;
}

bool RemoteScanner::ReadRemoteMemory(uintptr_t address, void* buffer, SIZE_T size) {
  SIZE_T bytesRead = 0;
  return ReadProcessMemory(hProcess, reinterpret_cast<PVOID>(address), buffer, size, &bytesRead) &&
         bytesRead == size;
}

std::string RemoteScanner::GetWeChatVersion() {
  RemoteModuleInfo moduleInfo;
  if (!GetRemoteModuleInfo("Weixin.dll", moduleInfo)) return "";

  WCHAR modulePath[MAX_PATH];
  if (GetModuleFileNameExW(hProcess, moduleInfo.baseAddress, modulePath, MAX_PATH) == 0) return "";

  DWORD handle = 0;
  DWORD versionSize = GetFileVersionInfoSizeW(modulePath, &handle);
  if (versionSize == 0) return "";

  std::vector<BYTE> versionData(versionSize);
  if (!GetFileVersionInfoW(modulePath, handle, versionSize, versionData.data())) return "";

  VS_FIXEDFILEINFO* fileInfo = nullptr;
  UINT fileInfoSize = 0;
  if (!VerQueryValueW(versionData.data(), L"\\", reinterpret_cast<LPVOID*>(&fileInfo), &fileInfoSize) ||
      !fileInfo) {
    return "";
  }

  std::stringstream ss;
  ss << HIWORD(fileInfo->dwProductVersionMS) << '.' << LOWORD(fileInfo->dwProductVersionMS) << '.'
     << HIWORD(fileInfo->dwProductVersionLS) << '.' << LOWORD(fileInfo->dwProductVersionLS);
  return ss.str();
}
