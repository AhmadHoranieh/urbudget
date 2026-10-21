#!/bin/sh
# Builds the shared Rust engine and services (crates/urbudget-ios) for the platform and
# architectures Xcode is building, as the static library the app links (-lurbudget_ios).
# Xcode runs this before compiling Swift; it can also run by hand with the variables below.
set -eu

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLATFORM="${PLATFORM_NAME:-iphonesimulator}"
OUT="${BUILT_PRODUCTS_DIR:-$ROOT/crates/target/ios}/rust"

case "${CONFIGURATION:-Debug}" in
  Release) PROFILE=release; FLAG=--release ;;
  *) PROFILE=debug; FLAG= ;;
esac

LIBS=""
for ARCH in ${ARCHS:-arm64}; do
  case "$PLATFORM:$ARCH" in
    iphoneos:arm64) TARGET=aarch64-apple-ios ;;
    iphonesimulator:arm64) TARGET=aarch64-apple-ios-sim ;;
    iphonesimulator:x86_64) TARGET=x86_64-apple-ios ;;
    *) echo "error: UrBudget's engine has no Rust target for $PLATFORM/$ARCH"; exit 1 ;;
  esac
  rustup target add "$TARGET" >/dev/null 2>&1 || true
  # Xcode's SDKROOT names the app's SDK. Build scripts run on the Mac, so cargo and the cc
  # crate pick each compilation's own SDK instead.
  env -u SDKROOT -u MACOSX_DEPLOYMENT_TARGET \
    IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-17.0}" \
    cargo build --manifest-path "$ROOT/crates/Cargo.toml" -p urbudget-ios --target "$TARGET" $FLAG
  LIBS="$LIBS $ROOT/crates/target/$TARGET/$PROFILE/liburbudget_ios.a"
done

mkdir -p "$OUT"
# shellcheck disable=SC2086
if [ "$(echo $LIBS | wc -w)" -gt 1 ]; then
  lipo -create $LIBS -output "$OUT/liburbudget_ios.a"
else
  cp -f $LIBS "$OUT/liburbudget_ios.a"
fi
