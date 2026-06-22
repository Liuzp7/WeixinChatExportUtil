#ifndef REMOTE_MEMORY_H
#define REMOTE_MEMORY_H

#include <Windows.h>

class RemoteMemory {
 public:
  RemoteMemory() = default;
  ~RemoteMemory() { reset(); }

  RemoteMemory(const RemoteMemory&) = delete;
  RemoteMemory& operator=(const RemoteMemory&) = delete;

  RemoteMemory(RemoteMemory&& other) noexcept { moveFrom(std::move(other)); }
  RemoteMemory& operator=(RemoteMemory&& other) noexcept {
    if (this != &other) {
      reset();
      moveFrom(std::move(other));
    }
    return *this;
  }

  static SIZE_T RoundToPageSize(SIZE_T size) {
    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    SIZE_T pageSize = si.dwPageSize ? si.dwPageSize : 4096;
    return (size + pageSize - 1) & ~(pageSize - 1);
  }

  bool allocate(HANDLE process, SIZE_T size, DWORD protect) {
    reset();
    hProcess = process;
    requestedSize = size;
    sizeBytes = RoundToPageSize(size);
    base = VirtualAllocEx(hProcess, nullptr, sizeBytes, MEM_COMMIT | MEM_RESERVE, protect);
    if (!base) {
      sizeBytes = 0;
      requestedSize = 0;
      hProcess = nullptr;
      return false;
    }
    return true;
  }

  void reset() {
    if (base && hProcess) {
      VirtualFreeEx(hProcess, base, 0, MEM_RELEASE);
    }
    base = nullptr;
    sizeBytes = 0;
    requestedSize = 0;
    hProcess = nullptr;
  }

  bool protect(DWORD newProtect, DWORD* oldProtect = nullptr) {
    if (!base || !hProcess || sizeBytes == 0) return false;
    PVOID address = base;
    SIZE_T regionSize = sizeBytes;
    return VirtualProtectEx(hProcess, address, regionSize, newProtect, oldProtect) != FALSE;
  }

  PVOID get() const { return base; }
  SIZE_T size() const { return sizeBytes; }
  SIZE_T requested() const { return requestedSize; }

 private:
  void moveFrom(RemoteMemory&& other) {
    hProcess = other.hProcess;
    base = other.base;
    sizeBytes = other.sizeBytes;
    requestedSize = other.requestedSize;
    other.hProcess = nullptr;
    other.base = nullptr;
    other.sizeBytes = 0;
    other.requestedSize = 0;
  }

  HANDLE hProcess{nullptr};
  PVOID base{nullptr};
  SIZE_T sizeBytes{0};
  SIZE_T requestedSize{0};
};

#endif
