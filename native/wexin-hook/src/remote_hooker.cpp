#include "../include/remote_hooker.h"

#include "../include/shared_key_data.h"
#include "../include/win32_util.h"

#include <cstring>

std::string g_lastInstallError;

namespace {

void SetInstallError(const std::string& message) { g_lastInstallError = message; }

void AppendBytes(std::vector<BYTE>& out, std::initializer_list<BYTE> bytes) {
  out.insert(out.end(), bytes.begin(), bytes.end());
}

void AppendQword(std::vector<BYTE>& out, uint64_t value) {
  for (int i = 0; i < 8; ++i) {
    out.push_back(static_cast<BYTE>((value >> (i * 8)) & 0xFF));
  }
}

void AppendDword(std::vector<BYTE>& out, uint32_t value) {
  for (int i = 0; i < 4; ++i) {
    out.push_back(static_cast<BYTE>((value >> (i * 8)) & 0xFF));
  }
}

}  // namespace

const char* RemoteHooker::GetLastInstallError() { return g_lastInstallError.c_str(); }

std::vector<BYTE> BuildHookShellcode(const ShellcodeConfig& config) {
  std::vector<BYTE> code;
  code.reserve(256);

  AppendBytes(code, {0x9C});  // pushfq
  for (BYTE reg : {0x50, 0x51, 0x52, 0x53, 0x55, 0x56, 0x57, 0x41, 0x50, 0x41, 0x51, 0x41, 0x52,
                   0x41, 0x53, 0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57}) {
    code.push_back(reg);
  }

  // mov rax, [rdx+0x10]
  AppendBytes(code, {0x48, 0x8B, 0x42, 0x10});
  // cmp rax, 32
  AppendBytes(code, {0x48, 0x83, 0xF8, 0x20});
  // jne skip (+0x2B from next insn)
  AppendBytes(code, {0x0F, 0x85, 0x2B, 0x00, 0x00, 0x00});

  // mov rcx, [rdx+0x08]
  AppendBytes(code, {0x48, 0x8B, 0x4A, 0x08});
  // mov rdx, sharedMemoryAddress
  AppendBytes(code, {0x48, 0xBA});
  AppendQword(code, reinterpret_cast<uint64_t>(config.sharedMemoryAddress));
  // mov rdi, rdx
  AppendBytes(code, {0x48, 0x89, 0xD7});
  // mov dword [rdi], 32
  AppendBytes(code, {0xC7, 0x07, 0x20, 0x00, 0x00, 0x00});
  // lea rdi, [rdi+4]
  AppendBytes(code, {0x48, 0x8D, 0x7F, 0x04});
  // mov rsi, rcx
  AppendBytes(code, {0x48, 0x89, 0xCE});
  // mov ecx, 32
  AppendBytes(code, {0xB9, 0x20, 0x00, 0x00, 0x00});
  // rep movsb
  AppendBytes(code, {0xF3, 0xA4});
  // mov eax, [rdx+36]
  AppendBytes(code, {0x8B, 0x42, 0x24});
  // inc eax
  AppendBytes(code, {0xFF, 0xC0});
  // mov [rdx+36], eax
  AppendBytes(code, {0x89, 0x42, 0x24});

  // skip: restore registers
  for (BYTE reg : {0x41, 0x5F, 0x41, 0x5E, 0x41, 0x5D, 0x41, 0x5C, 0x41, 0x5B, 0x41, 0x5A, 0x41, 0x59,
                   0x41, 0x58, 0x5F, 0x5E, 0x5D, 0x5B, 0x5A, 0x59, 0x58}) {
    code.push_back(reg);
  }
  AppendBytes(code, {0x9D});  // popfq
  // mov rax, trampolineAddress
  AppendBytes(code, {0x48, 0xB8});
  AppendQword(code, config.trampolineAddress);
  // jmp rax
  AppendBytes(code, {0xFF, 0xE0});

  return code;
}

namespace X64Disasm {

inline bool IsRexPrefix(BYTE b) { return b >= 0x40 && b <= 0x4F; }

size_t GetInstructionLength(const BYTE* code) {
  size_t len = 0;
  bool hasRex = false;
  if (IsRexPrefix(code[len])) {
    hasRex = true;
    len++;
  }

  BYTE opcode = code[len++];
  switch (opcode) {
    case 0x50:
    case 0x51:
    case 0x52:
    case 0x53:
    case 0x54:
    case 0x55:
    case 0x56:
    case 0x57:
    case 0x58:
    case 0x59:
    case 0x5A:
    case 0x5B:
    case 0x5C:
    case 0x5D:
    case 0x5E:
    case 0x5F:
    case 0x90:
    case 0xC3:
    case 0xCC:
      return len;
    case 0x88:
    case 0x89:
    case 0x8A:
    case 0x8B:
      len++;
      if ((code[len - 1] & 0xC0) != 0xC0) {
        BYTE modrm = code[len - 1];
        BYTE mod = (modrm >> 6) & 3;
        BYTE rm = modrm & 7;
        if (rm == 4) len++;
        if (mod == 1) len++;
        else if (mod == 2) len += 4;
      }
      return len;
    case 0xB0:
    case 0xB1:
    case 0xB2:
    case 0xB3:
    case 0xB4:
    case 0xB5:
    case 0xB6:
    case 0xB7:
      return len + 1;
    case 0xB8:
    case 0xB9:
    case 0xBA:
    case 0xBB:
    case 0xBC:
    case 0xBD:
    case 0xBE:
    case 0xBF:
      return len + (hasRex ? 8 : 4);
    case 0x70:
    case 0x71:
    case 0x72:
    case 0x73:
    case 0x74:
    case 0x75:
    case 0x76:
    case 0x77:
    case 0x78:
    case 0x79:
    case 0x7A:
    case 0x7B:
    case 0x7C:
    case 0x7D:
    case 0x7E:
    case 0x7F:
    case 0xEB:
      return len + 1;
    case 0xE8:
    case 0xE9:
      return len + 4;
    case 0x0F:
      len++;
      opcode = code[len - 1];
      if (opcode >= 0x80 && opcode <= 0x8F) return len + 4;
      return len + 1;
    case 0x8D:
      len++;
      if ((code[len - 1] & 0x07) == 4) len++;
      if (((code[len - 1] >> 6) & 3) == 2) len += 4;
      return len;
    default:
      return len + 1;
  }
}

}  // namespace X64Disasm

RemoteHooker::RemoteHooker(HANDLE hProcess) : hProcess(hProcess) {}

RemoteHooker::~RemoteHooker() { UninstallHook(); }

bool RemoteHooker::RemoteWrite(PVOID address, const void* data, SIZE_T size) {
  SIZE_T bytesWritten = 0;
  return WriteProcessMemory(hProcess, address, data, size, &bytesWritten) && bytesWritten == size;
}

bool RemoteHooker::RemoteRead(PVOID address, void* buffer, SIZE_T size) {
  SIZE_T bytesRead = 0;
  return ReadProcessMemory(hProcess, address, buffer, size, &bytesRead) && bytesRead == size;
}

size_t RemoteHooker::CalculateHookLength(const BYTE* code) {
  size_t totalLen = 0;
  while (totalLen < 14) {
    size_t instrLen = X64Disasm::GetInstructionLength(code + totalLen);
    if (instrLen == 0) return 0;
    totalLen += instrLen;
  }
  return totalLen;
}

std::vector<BYTE> RemoteHooker::GenerateJumpInstruction(uintptr_t from, uintptr_t to) {
  std::vector<BYTE> jmp;
  INT64 offset = static_cast<INT64>(to) - static_cast<INT64>(from) - 5;
  if (offset >= INT32_MIN && offset <= INT32_MAX) {
    jmp.push_back(0xE9);
    INT32 offset32 = static_cast<INT32>(offset);
    jmp.push_back(static_cast<BYTE>(offset32 & 0xFF));
    jmp.push_back(static_cast<BYTE>((offset32 >> 8) & 0xFF));
    jmp.push_back(static_cast<BYTE>((offset32 >> 16) & 0xFF));
    jmp.push_back(static_cast<BYTE>((offset32 >> 24) & 0xFF));
  } else {
    jmp.push_back(0x48);
    jmp.push_back(0xB8);
    for (int i = 0; i < 8; ++i) jmp.push_back(static_cast<BYTE>((to >> (i * 8)) & 0xFF));
    jmp.push_back(0xFF);
    jmp.push_back(0xE0);
  }
  return jmp;
}

bool RemoteHooker::CreateTrampoline(uintptr_t targetAddr) {
  BYTE originalCode[32]{};
  if (!RemoteRead(reinterpret_cast<PVOID>(targetAddr), originalCode, sizeof(originalCode))) {
    SetInstallError(FormatWin32Error("Read target function bytes failed"));
    return false;
  }

  size_t hookLen = CalculateHookLength(originalCode);
  if (hookLen == 0 || hookLen > 32) {
    SetInstallError("Could not determine hook length at target function");
    return false;
  }

  originalBytes.assign(originalCode, originalCode + hookLen);

  RemoteMemory trampMem;
  SIZE_T trampolineSize = hookLen + 14;
  if (!trampMem.allocate(hProcess, trampolineSize, PAGE_EXECUTE_READWRITE)) {
    SetInstallError(FormatWin32Error("Allocate trampoline memory failed"));
    return false;
  }

  trampolineAddress = reinterpret_cast<uintptr_t>(trampMem.get());
  if (!RemoteWrite(trampMem.get(), originalCode, hookLen)) {
    SetInstallError(FormatWin32Error("Write trampoline bytes failed"));
    return false;
  }

  std::vector<BYTE> jmpBack =
      GenerateJumpInstruction(trampolineAddress + hookLen, targetAddr + hookLen);
  if (!RemoteWrite(reinterpret_cast<PVOID>(trampolineAddress + hookLen), jmpBack.data(), jmpBack.size())) {
    SetInstallError(FormatWin32Error("Write trampoline jump failed"));
    trampolineAddress = 0;
    return false;
  }
  trampolineMemory = std::move(trampMem);
  return true;
}

bool RemoteHooker::InstallHook(uintptr_t targetFunctionAddress, const ShellcodeConfig& shellcodeConfig) {
  g_lastInstallError.clear();
  if (isHookInstalled) {
    SetInstallError("Hook already installed");
    return false;
  }
  targetAddress = targetFunctionAddress;
  if (!CreateTrampoline(targetAddress)) return false;

  ShellcodeConfig updatedConfig = shellcodeConfig;
  updatedConfig.trampolineAddress = trampolineAddress;
  std::vector<BYTE> shellcode = BuildHookShellcode(updatedConfig);

  RemoteMemory shellMem;
  if (!shellMem.allocate(hProcess, shellcode.size(), PAGE_EXECUTE_READWRITE)) {
    SetInstallError(FormatWin32Error("Allocate shellcode memory failed"));
    trampolineMemory.reset();
    trampolineAddress = 0;
    return false;
  }

  remoteShellcodeAddress = reinterpret_cast<uintptr_t>(shellMem.get());
  if (!RemoteWrite(shellMem.get(), shellcode.data(), shellcode.size())) {
    SetInstallError(FormatWin32Error("Write shellcode failed"));
    trampolineMemory.reset();
    trampolineAddress = 0;
    remoteShellcodeAddress = 0;
    return false;
  }
  shellcodeMemory = std::move(shellMem);

  std::vector<BYTE> hookJump = GenerateJumpInstruction(targetAddress, remoteShellcodeAddress);
  if (hookJump.size() > originalBytes.size()) {
    SetInstallError("Hook jump is larger than backed-up instructions");
    shellcodeMemory.reset();
    trampolineMemory.reset();
    remoteShellcodeAddress = 0;
    trampolineAddress = 0;
    return false;
  }
  while (hookJump.size() < originalBytes.size()) hookJump.push_back(0x90);

  DWORD oldProtect = 0;
  if (!VirtualProtectEx(hProcess, reinterpret_cast<PVOID>(targetAddress), originalBytes.size(),
                        PAGE_EXECUTE_READWRITE, &oldProtect)) {
    SetInstallError(FormatWin32Error("VirtualProtectEx on target function failed"));
    shellcodeMemory.reset();
    trampolineMemory.reset();
    remoteShellcodeAddress = 0;
    trampolineAddress = 0;
    return false;
  }

  bool writeSuccess =
      RemoteWrite(reinterpret_cast<PVOID>(targetAddress), hookJump.data(), hookJump.size());
  FlushInstructionCache(hProcess, reinterpret_cast<PVOID>(targetAddress), originalBytes.size());
  DWORD tempProtect = 0;
  VirtualProtectEx(hProcess, reinterpret_cast<PVOID>(targetAddress), originalBytes.size(), oldProtect,
                   &tempProtect);

  if (!writeSuccess) {
    SetInstallError(FormatWin32Error("Write hook jump to target function failed"));
    shellcodeMemory.reset();
    trampolineMemory.reset();
    remoteShellcodeAddress = 0;
    trampolineAddress = 0;
    return false;
  }

  isHookInstalled = true;
  return true;
}

bool RemoteHooker::UninstallHook() {
  if (!isHookInstalled) return true;

  DWORD oldProtect = 0;
  if (VirtualProtectEx(hProcess, reinterpret_cast<PVOID>(targetAddress), originalBytes.size(),
                       PAGE_EXECUTE_READWRITE, &oldProtect)) {
    RemoteWrite(reinterpret_cast<PVOID>(targetAddress), originalBytes.data(), originalBytes.size());
    DWORD tempProtect = 0;
    VirtualProtectEx(hProcess, reinterpret_cast<PVOID>(targetAddress), originalBytes.size(), oldProtect,
                     &tempProtect);
  }

  shellcodeMemory.reset();
  remoteShellcodeAddress = 0;
  trampolineMemory.reset();
  trampolineAddress = 0;
  isHookInstalled = false;
  return true;
}
