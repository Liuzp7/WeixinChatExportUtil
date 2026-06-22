#ifndef WEXIN_HOOK_API_H
#define WEXIN_HOOK_API_H

#include <Windows.h>

#ifdef WEXIN_HOOK_EXPORTS
#define WEXIN_HOOK_API extern "C" __declspec(dllexport)
#else
#define WEXIN_HOOK_API extern "C" __declspec(dllimport)
#endif

WEXIN_HOOK_API bool InitializeHook(DWORD targetPid);
WEXIN_HOOK_API bool PollKeyData(char* keyBuffer, int bufferSize);
WEXIN_HOOK_API bool GetStatusMessage(char* statusBuffer, int bufferSize, int* outLevel);
WEXIN_HOOK_API bool CleanupHook();
WEXIN_HOOK_API const char* GetLastErrorMsg();

#endif
