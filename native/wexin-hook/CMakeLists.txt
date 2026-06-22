cmake_minimum_required(VERSION 3.20)
project(wexin_hook LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(wexin_hook SHARED
  src/dllmain.cpp
  src/hook_engine.cpp
  src/remote_scanner.cpp
  src/remote_hooker.cpp
  src/win32_util.cpp
)

target_include_directories(wexin_hook PRIVATE include)
target_compile_definitions(wexin_hook PRIVATE WEXIN_HOOK_EXPORTS UNICODE _UNICODE)
target_link_libraries(wexin_hook PRIVATE Psapi version)

set(DLL_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/../../assets/dll")
file(MAKE_DIRECTORY "${DLL_OUTPUT_DIR}")

if(MSVC)
  foreach(CONFIG_TYPE ${CMAKE_CONFIGURATION_TYPES})
    string(TOUPPER ${CONFIG_TYPE} CONFIG_TYPE_UPPER)
    set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_${CONFIG_TYPE_UPPER} "${DLL_OUTPUT_DIR}")
  endforeach()
else()
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${DLL_OUTPUT_DIR}")
endif()

set_target_properties(wexin_hook PROPERTIES
  OUTPUT_NAME "wexin_hook"
)
