cmake_minimum_required(VERSION 3.16)
project(oi_judge VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})

add_executable(oi-judge
    src/main.cpp
    src/cli.cpp
    src/judge.cpp
    src/json.cpp
    src/config.cpp
    src/types.cpp
    src/compiler.cpp
    src/runner.cpp
    src/comparator.cpp
    src/checker.cpp
    src/freopen_scan.cpp
    src/server.cpp
    src/fetcher.cpp
)

target_include_directories(oi-judge PRIVATE include)

target_compile_definitions(oi-judge PRIVATE
    OI_DISPLAY_VERSION="V0.1.0-100"
    OI_BUILD=100
)

if(WIN32)
    target_link_libraries(oi-judge PRIVATE kernel32 psapi ws2_32 winhttp)
endif()
