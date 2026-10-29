#!/bin/bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
command -v qs >/dev/null || { echo 'native transport tests need Quickshell' >&2; exit 1; }
[[ -x $repo/plugin/bin/oma-cast-search ]] || { echo 'run bin/build-search before native transport tests' >&2; exit 1; }
fixture=$(mktemp -d /tmp/oma-cast-search.XXXXXXXX)
touch "$fixture/.oma-cast-search-test"
cleanup() {
  [[ $fixture == /tmp/oma-cast-search.* && -f $fixture/.oma-cast-search-test ]] || return 1
  rm -rf -- "$fixture"
}
trap cleanup EXIT

printf '#!/bin/bash\nread -r line\nexit 0\n' > "$fixture/exit0"
printf '#!/bin/bash\nread -r line\nexit 1\n' > "$fixture/exit1"
printf '#!/bin/bash\nread -r line\nprintf "bad json\\n"\nexec sleep 10\n' > "$fixture/malformed"
printf '#!/bin/bash\nread -r line\nexec sleep 10\n' > "$fixture/hang"
printf '#!/bin/bash\nexit 0\n' > "$fixture/nonexecutable"
chmod +x "$fixture/exit0" "$fixture/exit1" "$fixture/malformed" "$fixture/hang"
chmod 600 "$fixture/nonexecutable"

for name in native missing nonexecutable exit0 exit1 malformed hang; do
  helper="$fixture/$name"
  fallback=1
  expected=""
  case $name in
    missing | nonexecutable | exit0 | exit1) expected="exited" ;;
    malformed) expected="SyntaxError" ;;
    hang) expected="timed out" ;;
  esac
  if [[ $name == native ]]; then helper="$repo/plugin/bin/oma-cast-search"; fallback=0; fi
  OMA_CAST_TEST_HELPER="$helper" OMA_CAST_EXPECT_FALLBACK="$fallback" OMA_CAST_EXPECT_FAILURE="$expected" QT_QPA_PLATFORM=offscreen \
    timeout 8 qs -p "$repo/test-search.qml" > "$fixture/$name.log" 2>&1 || {
      cat "$fixture/$name.log" >&2
      echo "native transport test failed: $name" >&2
      exit 1
    }
  grep -q NATIVE-SEARCH-PASS "$fixture/$name.log" || { cat "$fixture/$name.log" >&2; exit 1; }
  echo "native transport PASS $name"
done

mkdir -p "$fixture/path with spaces"
cp -R "$repo/plugin" "$fixture/path with spaces/plugin"
cp "$repo/test-search.qml" "$fixture/path with spaces/test-search.qml"
QT_QPA_PLATFORM=offscreen timeout 8 qs -p "$fixture/path with spaces/test-search.qml" > "$fixture/path.log" 2>&1 || {
  cat "$fixture/path.log" >&2
  echo 'native transport test failed: default helper path with spaces' >&2
  exit 1
}
grep -q NATIVE-SEARCH-PASS "$fixture/path.log" || { cat "$fixture/path.log" >&2; exit 1; }
echo 'native transport PASS default helper path with spaces'
