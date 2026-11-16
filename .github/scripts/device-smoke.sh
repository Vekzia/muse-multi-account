#!/usr/bin/env bash
set -euo pipefail

# First-time dependency compilation can outlast the emulator's screen timeout.
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 2147483647
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard

mkdir -p app/build/smoke-screenshots app/build/device-diagnostics
adb shell dumpsys power > app/build/device-diagnostics/power-before.txt
adb shell dumpsys window > app/build/device-diagnostics/window-before.txt

status=0
./gradlew --no-daemon --console=plain connectedDebugAndroidTest || status=$?

# Preserve diagnostics even when Gradle fails; never hide the test exit code.
adb shell dumpsys power > app/build/device-diagnostics/power-after.txt || true
adb shell dumpsys window > app/build/device-diagnostics/window-after.txt || true
adb logcat -d > app/build/device-diagnostics/logcat.txt || true
adb exec-out screencap -p > app/build/device-diagnostics/screen-after.png || true
adb pull /sdcard/Android/data/com.seekstars.muselauncher/files/smoke app/build/smoke-screenshots || true
exit "$status"
