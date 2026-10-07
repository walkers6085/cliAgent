#!/usr/bin/env bash
set -euo pipefail

# cliagent Korean IME Fix Installer
#
# Patches cliagent to prevent Korean (and other CJK) IME last character
# truncation when pressing Enter in Kitty and other terminals.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/walkers6085/cliAgent/main/patches/install-korean-ime-fix.sh | bash
#   # or from a cloned repo:
#   ./patches/install-korean-ime-fix.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[38;5;214m'
MUTED='\033[0;2m'
NC='\033[0m'

CLIAGENT_DIR="${CLIAGENT_DIR:-$HOME/.cliagent}"
CLIAGENT_SRC="${CLIAGENT_SRC:-$HOME/.cliagent-src}"
SOURCE_REPO="${SOURCE_REPO:-https://github.com/walkers6085/cliAgent.git}"
SOURCE_BRANCH="${SOURCE_BRANCH:-main}"

info()  { echo -e "${MUTED}$*${NC}"; }
warn()  { echo -e "${ORANGE}$*${NC}"; }
err()   { echo -e "${RED}$*${NC}" >&2; }
ok()    { echo -e "${GREEN}$*${NC}"; }

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Error: $1 is required but not installed."
    exit 1
  fi
}

need git
need bun

# ── 1. Clone or update source ────────────────────────────────────────
if [ -d "$CLIAGENT_SRC/.git" ]; then
  info "Updating existing source at $CLIAGENT_SRC ..."
  git -C "$CLIAGENT_SRC" fetch origin "$SOURCE_BRANCH"
  git -C "$CLIAGENT_SRC" checkout "$SOURCE_BRANCH"
  git -C "$CLIAGENT_SRC" reset --hard "origin/$SOURCE_BRANCH"
else
  info "Cloning cliAgent source (shallow) to $CLIAGENT_SRC ..."
  git clone --depth 1 --branch "$SOURCE_BRANCH" "$SOURCE_REPO" "$CLIAGENT_SRC"
fi

# ── 2. Verify the IME fix is present in source ────────────────────────
PROMPT_FILE="$CLIAGENT_SRC/packages/cliagent/src/cli/cmd/tui/component/prompt/index.tsx"
if [ ! -f "$PROMPT_FILE" ]; then
  err "Prompt file not found: $PROMPT_FILE"
  exit 1
fi

if grep -q "setTimeout(() => setTimeout" "$PROMPT_FILE"; then
  ok "IME fix already present in source."
else
  warn "IME fix not found. Applying patch ..."
  # Apply the fix: replace onSubmit={submit} with double-deferred version
  sed -i 's|onSubmit={submit}|onSubmit={() => {\n                // IME: double-defer so the last composed character (e.g. Korean\n                // hangul) is flushed to plainText before we read it for submission.\n                setTimeout(() => setTimeout(() => submit(), 0), 0)\n              }}|' "$PROMPT_FILE"
  if grep -q "setTimeout(() => setTimeout" "$PROMPT_FILE"; then
    ok "Patch applied."
  else
    err "Failed to apply patch. The source may have changed."
    exit 1
  fi
fi

# ── 3. Install dependencies ────────────────────────────────────────────
info "Installing dependencies (this may take a minute) ..."
cd "$CLIAGENT_SRC"
bun install --frozen-lockfile 2>/dev/null || bun install

# ── 4. Build (current platform only) ──────────────────────────────────
info "Building cliagent for current platform ..."
cd "$CLIAGENT_SRC/packages/cliagent"
bun run build --single

# ── 5. Install binary ──────────────────────────────────────────────────
mkdir -p "$CLIAGENT_DIR/bin"

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
[ "$PLATFORM" = "darwin" ] && true
[ "$PLATFORM" = "linux" ] && true

BUILT_BINARY="$CLIAGENT_SRC/packages/cliagent/dist/cliagent-${PLATFORM}-${ARCH}/bin/cliagent"

if [ ! -f "$BUILT_BINARY" ]; then
  BUILT_BINARY=$(find "$CLIAGENT_SRC/packages/cliagent/dist" -name "cliagent" -type f -executable 2>/dev/null | head -1)
fi

if [ -f "$BUILT_BINARY" ]; then
  if [ -f "$CLIAGENT_DIR/bin/cliagent" ]; then
    cp "$CLIAGENT_DIR/bin/cliagent" "$CLIAGENT_DIR/bin/cliagent.bak.$(date +%Y%m%d%H%M%S)"
  fi
  cp "$BUILT_BINARY" "$CLIAGENT_DIR/bin/cliagent"
  chmod +x "$CLIAGENT_DIR/bin/cliagent"
  ok "Installed to $CLIAGENT_DIR/bin/cliagent"
else
  err "Build failed - binary not found in dist/"
  info "Try running manually:"
  echo "  cd $CLIAGENT_SRC/packages/cliagent && bun run build --single"
  exit 1
fi

echo ""
ok "Done! Korean IME fix is now active."
echo ""
info "To uninstall and revert to a clean build, rebuild from source:"
echo "  git clone https://github.com/walkers6085/cliAgent.git && bun install"
echo ""
info "To update (re-pull and rebuild):"
echo "  $0"
