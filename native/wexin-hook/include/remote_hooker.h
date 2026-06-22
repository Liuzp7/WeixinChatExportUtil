#ifndef REMOTE_HOOKER_H
#define REMOTE_HOOKER_H

#include <Windows.h>
#include <vector>
#include "remote_memory.h"

struct ShellcodeConfig {
  PVOID sharedMemoryAddress;
  uintptr_t trampolineAddress;
};

class RemoteHooker {
 public:
  explicit RemoteHooker(HANDLE hProcess);
  ~RemoteHooker();

  bool InstallHook(uintptr_t targetFunctionAddress, const ShellcodeConfig& shellcodeConfig);
  bool UninstallHook();
  static const char* GetLastInstallError();

 private:
  HANDLE hProcess;
  uintptr_t targetAddress{0};
  uintptr_t remoteShellcodeAddress{0};
  uintptr_t trampolineAddress{0};
  std::vector<BYTE> originalBytes;
  bool isHookInstalled{false};
  RemoteMemory trampolineMemory;
  RemoteMemory shellcodeMemory;

  bool RemoteWrite(PVOID address, const void* data, SIZE_T size);
  bool RemoteRead(PVOID address, void* buffer, SIZE_T size);
  bool CreateTrampoline(uintptr_t targetAddr);
  size_t CalculateHookLength(const BYTE* code);
  std::vector<BYTE> GenerateJumpInstruction(uintptr_t from, uintptr_t to);
};

std::vector<BYTE> BuildHookShellcode(const ShellcodeConfig& config);

#endif
