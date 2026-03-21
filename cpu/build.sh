#!/bin/bash
#
# Build WASM 6502 CPU emulator using Emscripten.
#
# Prerequisites:
#   - Emscripten SDK installed and activated (source emsdk_env.sh)
#   - emcc available on PATH
#
# Output:
#   cpu/dist/6502.js      — ES module (Node.js + browser)
#   cpu/dist/6502.wasm    — WebAssembly binary
#
# Usage:
#   cd cpu && ./build.sh
#   # or from project root:
#   bash cpu/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/6502.c"
OUT_DIR="$SCRIPT_DIR/dist"
OUT_JS="$OUT_DIR/6502.js"

mkdir -p "$OUT_DIR"

# Check for emcc
if ! command -v emcc &>/dev/null; then
    echo "ERROR: emcc not found. Install Emscripten SDK first."
    echo "  See: https://emscripten.org/docs/getting_started/downloads.html"
    exit 1
fi

echo "Building 6502 WASM CPU emulator..."

emcc "$SRC" \
    -o "$OUT_JS" \
    -O2 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='[
        "_cpu_wasm_init",
        "_cpu_wasm_run",
        "_cpu_get_instance",
        "_cpu_get_pc", "_cpu_set_pc",
        "_cpu_get_a",  "_cpu_set_a",
        "_cpu_get_x",  "_cpu_set_x",
        "_cpu_get_y",  "_cpu_set_y",
        "_cpu_get_s",  "_cpu_set_s",
        "_cpu_get_p_reg", "_cpu_set_p_reg",
        "_cpu_get_cycle_counter", "_cpu_set_cycle_counter",
        "_cpu_get_phase", "_cpu_set_phase",
        "_cpu_get_undocumented",
        "_cpu_get_crashed", "_cpu_set_crashed",
        "_cpu_add_breakpoint", "_cpu_remove_breakpoint", "_cpu_clear_breakpoints",
        "_cpu_add_watchpoint", "_cpu_remove_watchpoint", "_cpu_clear_watchpoints",
        "_cpu_set_cycle_limit",
        "_malloc", "_free"
    ]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue"]' \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME=createCPU6502 \
    -s ENVIRONMENT='web,node' \
    -s ALLOW_MEMORY_GROWTH=0 \
    -s INITIAL_MEMORY=65536 \
    -s IMPORTED_MEMORY=0 \
    -s FILESYSTEM=0 \
    -s ASSERTIONS=0 \
    -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
    --no-entry

echo "Build complete: $OUT_JS"
echo "WASM binary:    $OUT_DIR/6502.wasm"
echo ""
echo "To use in Node.js:"
echo '  import createCPU6502 from "./cpu/dist/6502.js";'
echo '  const Module = await createCPU6502({ mem_read, mem_write });'
echo ""

# Also build a native test binary if cc is available
if command -v cc &>/dev/null; then
    echo "Building native test binary..."
    cc "$SRC" "$SCRIPT_DIR/test_native.c" \
        -o "$OUT_DIR/test_native" \
        -O2 -Wall -Wextra \
        -I"$SCRIPT_DIR" \
        2>/dev/null && echo "Native test binary: $OUT_DIR/test_native" \
        || echo "Native test binary build skipped (missing test_native.c or compile error)"
fi
