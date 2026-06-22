#include "../include/wexin_hook_api.h"
#include "../include/remote_scanner.h"
#include "../include/remote_hooker.h"
#include "../include/remote_memory.h"
#include "../include/shared_key_data.h"
#include "../include/win32_util.h"

#include <atomic>
#include <cstring>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

struct StatusMessage {
  std::string message;
  int level;
};

struct HookContext {
  HANDLE hProcess{nullptr};
  std::unique_ptr<RemoteHooker> hooker;
  RemoteMemory remoteData;
  CRITICAL_SECTION dataLock{};
  bool csInitialized{false};
  std::string pendingKeyData;
  bool hasNewKey{false};
  std::vector<StatusMessage> statusQueue;
  bool initialized{false};
  std::thread pollThread;
  std::atomic<bool> stopPolling{false};
  DWORD lastSequenceNumber{0};

  void InitLock() {
    if (!csInitialized) {
      InitializeCriticalSection(&dataLock);
      csInitialized = true;
    }
  }

  void FreeLock() {
    if (csInitialized) {
      DeleteCriticalSection(&dataLock);
      csInitialized = false;
    }
  }

  void ResetDataQueues(bool clearStatus = true) {
    pendingKeyData.clear();
    hasNewKey = false;
    if (clearStatus) {
      statusQueue.clear();
    }
    lastSequenceNumber = 0;
  }
};

HookContext g_ctx;
std::string g_lastError;
const char* kSupportedRange = "WeChat 4.0.x - 4.x";

void SendStatus(const std::string& message, int level) {
  if (g_ctx.csInitialized) EnterCriticalSection(&g_ctx.dataLock);
  g_ctx.statusQueue.push_back({message, level});
  if (g_ctx.statusQueue.size() > 100) {
    g_ctx.statusQueue.erase(g_ctx.statusQueue.begin());
  }
  if (g_ctx.csInitialized) LeaveCriticalSection(&g_ctx.dataLock);
}

void SetLastErrorMsg(const std::string& error) {
  g_lastError = error;
  SendStatus(error, 2);
}

void OnKeyCaptured(const SharedKeyData& data) {
  if (data.dataSize != 32) {
    SendStatus("Invalid key length received", 2);
    return;
  }

  std::stringstream ss;
  ss << std::hex;
  for (DWORD i = 0; i < data.dataSize; i++) {
    ss.width(2);
    ss.fill('0');
    ss << static_cast<int>(data.keyBuffer[i]);
  }

  if (g_ctx.csInitialized) EnterCriticalSection(&g_ctx.dataLock);
  g_ctx.pendingKeyData = ss.str();
  g_ctx.hasNewKey = true;
  if (g_ctx.csInitialized) LeaveCriticalSection(&g_ctx.dataLock);

  SendStatus("Key captured successfully", 1);
}

void PollRemoteBufferLoop() {
  while (!g_ctx.stopPolling.load()) {
    if (!g_ctx.hProcess || !g_ctx.remoteData.get()) {
      Sleep(80);
      continue;
    }

    SharedKeyData keyData{};
    SIZE_T bytesRead = 0;
    if (ReadProcessMemory(g_ctx.hProcess, g_ctx.remoteData.get(), &keyData, sizeof(SharedKeyData),
                          &bytesRead) &&
        bytesRead == sizeof(SharedKeyData)) {
      if (keyData.dataSize > 0 && keyData.dataSize <= 32 && keyData.sequenceNumber != 0 &&
          keyData.sequenceNumber != g_ctx.lastSequenceNumber) {
        g_ctx.lastSequenceNumber = keyData.sequenceNumber;
        OnKeyCaptured(keyData);

        SharedKeyData zeroData{};
        SIZE_T bytesWritten = 0;
        WriteProcessMemory(g_ctx.hProcess, g_ctx.remoteData.get(), &zeroData, sizeof(SharedKeyData),
                           &bytesWritten);
      }
    }
    Sleep(80);
  }
}

void CleanupContext() {
  g_ctx.stopPolling.store(true);
  if (g_ctx.pollThread.joinable()) {
    g_ctx.pollThread.join();
  }

  if (g_ctx.hooker) {
    g_ctx.hooker->UninstallHook();
    g_ctx.hooker.reset();
  }

  g_ctx.remoteData.reset();

  if (g_ctx.hProcess) {
    CloseHandle(g_ctx.hProcess);
    g_ctx.hProcess = nullptr;
  }

  if (g_ctx.csInitialized) {
    EnterCriticalSection(&g_ctx.dataLock);
    g_ctx.pendingKeyData.clear();
    g_ctx.hasNewKey = false;
    g_ctx.lastSequenceNumber = 0;
    if (g_ctx.initialized) {
      g_ctx.statusQueue.clear();
    }
    LeaveCriticalSection(&g_ctx.dataLock);
    g_ctx.FreeLock();
  }

  g_ctx.initialized = false;
}

bool InitializeContext(DWORD targetPid) {
  if (g_ctx.initialized) {
    SetLastErrorMsg("Hook already initialized");
    return false;
  }

  g_ctx.InitLock();
  g_ctx.ResetDataQueues();
  g_ctx.stopPolling.store(false);

  SendStatus("Initializing built-in hook module...", 0);

  if (!EnableDebugPrivilege()) {
    SendStatus("Warning: failed to enable SeDebugPrivilege. Hook may fail without admin rights.", 0);
  }

  g_ctx.hProcess = OpenProcess(PROCESS_ALL_ACCESS, FALSE, targetPid);
  if (!g_ctx.hProcess) {
    SetLastErrorMsg("Failed to open target process. Run as administrator.");
    CleanupContext();
    return false;
  }

  SendStatus("Detecting WeChat version...", 0);
  RemoteScanner scanner(g_ctx.hProcess);
  std::string wechatVersion = scanner.GetWeChatVersion();
  if (wechatVersion.empty()) {
    SetLastErrorMsg("Failed to read WeChat version. Target process may have exited.");
    CleanupContext();
    return false;
  }

  {
    std::stringstream versionMsg;
    versionMsg << "WeChat version: " << wechatVersion;
    SendStatus(versionMsg.str(), 0);
  }

  const WeChatVersionConfig* config = VersionConfigManager::GetConfigForVersion(wechatVersion);
  if (!config) {
    std::string errorMsg =
        std::string("Unsupported WeChat version: ") + wechatVersion + ". Supported: " + kSupportedRange;
    SetLastErrorMsg(errorMsg);
    CleanupContext();
    return false;
  }

  SendStatus("Scanning Weixin.dll for target function...", 0);
  RemoteModuleInfo moduleInfo;
  if (!scanner.GetRemoteModuleInfo("Weixin.dll", moduleInfo)) {
    SetLastErrorMsg("Weixin.dll module not found");
    CleanupContext();
    return false;
  }

  std::vector<uintptr_t> results =
      scanner.FindAllPatterns(moduleInfo, config->pattern.data(), config->mask.c_str());
  if (results.size() != 1) {
    std::stringstream errorMsg;
    errorMsg << "Pattern match failed, found " << results.size() << " results";
    SetLastErrorMsg(errorMsg.str());
    CleanupContext();
    return false;
  }

  uintptr_t targetFunctionAddress = results[0] + config->offset;
  {
    std::stringstream addrMsg;
    addrMsg << "Target function address: 0x" << std::hex << targetFunctionAddress;
    SendStatus(addrMsg.str(), 0);
  }

  SendStatus("Allocating remote data buffer...", 0);
  if (!g_ctx.remoteData.allocate(g_ctx.hProcess, sizeof(SharedKeyData), PAGE_READWRITE)) {
    SetLastErrorMsg("Failed to allocate remote data buffer");
    CleanupContext();
    return false;
  }

  g_ctx.pollThread = std::thread(PollRemoteBufferLoop);

  SendStatus("Installing remote hook...", 0);
  g_ctx.hooker = std::make_unique<RemoteHooker>(g_ctx.hProcess);
  ShellcodeConfig shellcodeConfig{};
  shellcodeConfig.sharedMemoryAddress = g_ctx.remoteData.get();
  shellcodeConfig.trampolineAddress = 0;

  if (!g_ctx.hooker->InstallHook(targetFunctionAddress, shellcodeConfig)) {
    std::string detail = RemoteHooker::GetLastInstallError();
    if (detail.empty()) {
      detail = "Failed to install hook";
    }
    SetLastErrorMsg(detail);
    CleanupContext();
    return false;
  }

  g_ctx.initialized = true;
  SendStatus("Hook installed. Please click Login in WeChat.", 1);
  return true;
}

}  // namespace

extern "C" {

WEXIN_HOOK_API bool InitializeHook(DWORD targetPid) { return InitializeContext(targetPid); }

WEXIN_HOOK_API bool CleanupHook() {
  if (!g_ctx.initialized) return true;
  SendStatus("Cleaning up hook...", 0);
  CleanupContext();
  return true;
}

WEXIN_HOOK_API bool PollKeyData(char* keyBuffer, int bufferSize) {
  if (!g_ctx.initialized || !keyBuffer || bufferSize < 65) return false;

  if (g_ctx.csInitialized) EnterCriticalSection(&g_ctx.dataLock);
  if (!g_ctx.hasNewKey) {
    if (g_ctx.csInitialized) LeaveCriticalSection(&g_ctx.dataLock);
    return false;
  }

  size_t copyLen = (g_ctx.pendingKeyData.length() < static_cast<size_t>(bufferSize - 1))
                       ? g_ctx.pendingKeyData.length()
                       : static_cast<size_t>(bufferSize - 1);
  memcpy(keyBuffer, g_ctx.pendingKeyData.c_str(), copyLen);
  keyBuffer[copyLen] = '\0';
  g_ctx.hasNewKey = false;
  g_ctx.pendingKeyData.clear();
  if (g_ctx.csInitialized) LeaveCriticalSection(&g_ctx.dataLock);
  return true;
}

WEXIN_HOOK_API bool GetStatusMessage(char* statusBuffer, int bufferSize, int* outLevel) {
  if (!statusBuffer || bufferSize < 256 || !outLevel) return false;

  if (!g_ctx.csInitialized) {
    return false;
  }

  EnterCriticalSection(&g_ctx.dataLock);
  if (g_ctx.statusQueue.empty()) {
    LeaveCriticalSection(&g_ctx.dataLock);
    return false;
  }

  StatusMessage msg = g_ctx.statusQueue.front();
  g_ctx.statusQueue.erase(g_ctx.statusQueue.begin());
  LeaveCriticalSection(&g_ctx.dataLock);

  size_t copyLen = (msg.message.length() < static_cast<size_t>(bufferSize - 1))
                       ? msg.message.length()
                       : static_cast<size_t>(bufferSize - 1);
  memcpy(statusBuffer, msg.message.c_str(), copyLen);
  statusBuffer[copyLen] = '\0';
  *outLevel = msg.level;
  return true;
}

WEXIN_HOOK_API const char* GetLastErrorMsg() { return g_lastError.c_str(); }

}  // extern "C"
