#ifndef REMOTE_SCANNER_H
#define REMOTE_SCANNER_H

#include <Windows.h>
#include <Psapi.h>
#include <string>
#include <vector>

struct RemoteModuleInfo {
  HMODULE baseAddress;
  SIZE_T imageSize;
  std::string moduleName;
};

struct WeChatVersionConfig {
  std::string versionRule;
  std::vector<BYTE> pattern;
  std::string mask;
  int offset;
};

class RemoteScanner {
 public:
  explicit RemoteScanner(HANDLE hProcess);
  bool GetRemoteModuleInfo(const std::string& moduleName, RemoteModuleInfo& outInfo);
  std::vector<uintptr_t> FindAllPatterns(const RemoteModuleInfo& moduleInfo, const BYTE* pattern, const char* mask);
  std::string GetWeChatVersion();
  bool ReadRemoteMemory(uintptr_t address, void* buffer, SIZE_T size);

 private:
  HANDLE hProcess;
  std::vector<BYTE> scanBuffer;
  bool MatchPattern(const BYTE* data, const BYTE* pattern, const char* mask, size_t length);
};

class VersionConfigManager {
 public:
  static const WeChatVersionConfig* GetConfigForVersion(const std::string& version);

 private:
  static void InitializeConfigs();
  static std::vector<WeChatVersionConfig> configs;
  static bool initialized;
};

#endif
