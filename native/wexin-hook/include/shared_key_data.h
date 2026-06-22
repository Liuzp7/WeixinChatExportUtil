#ifndef SHARED_KEY_DATA_H
#define SHARED_KEY_DATA_H

#include <Windows.h>

#pragma pack(push, 1)
struct SharedKeyData {
  DWORD dataSize;
  BYTE keyBuffer[32];
  DWORD sequenceNumber;
};
#pragma pack(pop)

#endif
