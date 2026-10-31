#!/usr/bin/env bash
#
# buka ai installer
#
#   curl -fsSL https://raw.githubusercontent.com/forsha7class/buka-ai/main/install.sh | bash
#   git clone https://github.com/forsha7class/buka-ai.git && cd buka-ai && ./install.sh
#
# Environment:
#   BUKA_HOME      install directory for curl mode (default: ~/.buka-ai)
#   BUKA_VERSION   branch or tag to install (default: main)
#   BUKA_REPO      GitHub repo slug (default: forsha7class/buka-ai)
#   BUKA_ARCHIVE_BASE  override the archive URL base (mirrors/testing)
#   BUKA_BIN_DIR   directory for the `buka` launcher
#
# Options:
#   --uninstall    remove the `buka` launcher
#   -h, --help     show this help

set -euo pipefail

REPO_SLUG="${BUKA_REPO:-forsha7class/buka-ai}"
VERSION="${BUKA_VERSION:-main}"
ARCHIVE_BASE="${BUKA_ARCHIVE_BASE:-https://github.com/$REPO_SLUG/archive}"
BUKA_HOME="${BUKA_HOME:-$HOME/.buka-ai}"
if [ -n "${BUKA_BIN_DIR:-}" ]; then
  case "$BUKA_BIN_DIR" in
    /*) ;;
    *) printf 'error: BUKA_BIN_DIR must be an absolute path: %s\n' "$BUKA_BIN_DIR" >&2; exit 1 ;;
  esac
fi
MIN_NODE_MAJOR=22
MARKER="# installed by buka-ai installer"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
buka ai installer

Usage:
  ./install.sh                 install from this checkout
  curl ... | bash              install to ~/.buka-ai
  ./install.sh --uninstall     remove the buka launcher

Environment:
  BUKA_HOME      install directory for curl mode (default: ~/.buka-ai)
  BUKA_VERSION   branch or tag to install (default: main)
  BUKA_REPO      GitHub repo slug (default: forsha7class/buka-ai)
  BUKA_ARCHIVE_BASE  override the archive URL base (mirrors/testing)
  BUKA_BIN_DIR   directory for the buka launcher
EOF
}

MODE=install
for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE=uninstall ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

launcher_candidates() {
  if [ -n "${BUKA_BIN_DIR:-}" ]; then printf '%s\n' "$BUKA_BIN_DIR"; fi
  printf '%s\n' /usr/local/bin "$HOME/.local/bin" "$HOME/bin"
}

is_ours() {
  if [ -L "$1" ]; then
    case "$(readlink "$1")" in
      */buka-ai/bin/buka|"$BUKA_HOME/bin/buka") return 0 ;;
    esac
  fi
  [ -f "$1" ] || return 1
  grep -qF "$MARKER" "$1" 2>/dev/null
}

if [ "$MODE" = uninstall ]; then
  removed=0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    target="$dir/buka"
    if is_ours "$target"; then
      rm -f "$target"
      say "removed $target"
      removed=1
    fi
  done < <(launcher_candidates)
  [ "$removed" -eq 1 ] || say "no buka launcher found"
  say "If you installed via curl, remove the app files with: rm -rf \"$BUKA_HOME\""
  exit 0
fi

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm not found. Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null || die "Node.js ${MIN_NODE_MAJOR}+ required (found $(node --version 2>/dev/null || echo unknown))."

SOURCE_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$candidate/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"buka-ai"' "$candidate/package.json"; then
    SOURCE_DIR="$candidate"
  fi
fi

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT

if [ -n "$SOURCE_DIR" ]; then
  INSTALL_DIR="$SOURCE_DIR"
  say "Installing buka ai from $INSTALL_DIR"
else
  command -v curl >/dev/null 2>&1 || die "curl is required for the remote installer"
  command -v tar >/dev/null 2>&1 || die "tar is required for the remote installer"

  case "$BUKA_HOME" in
    /*) ;;
    *) die "BUKA_HOME must be an absolute path: $BUKA_HOME" ;;
  esac
  case "$BUKA_HOME" in
    "/"|"$HOME"|"$HOME/"|*"/../"*|*"/..") die "refusing to use an unsafe BUKA_HOME: $BUKA_HOME" ;;
  esac
  if [ -e "$BUKA_HOME" ]; then
    if [ -d "$BUKA_HOME/.git" ]; then
      die "$BUKA_HOME is a development checkout; run ./install.sh from it instead"
    fi
    if [ ! -f "$BUKA_HOME/package.json" ] || ! grep -q '"name"[[:space:]]*:[[:space:]]*"buka-ai"' "$BUKA_HOME/package.json"; then
      die "$BUKA_HOME already exists and is not a buka-ai install; refusing to replace it"
    fi
  fi

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/buka-install.XXXXXX")"
  mkdir -p "$TMP_DIR/src"

  say "Downloading buka ai ($VERSION) from $ARCHIVE_BASE..."
  downloaded=0
  for ref in "refs/heads/$VERSION" "refs/tags/$VERSION"; do
    url="$ARCHIVE_BASE/$ref.tar.gz"
    if curl -fsSL "$url" -o "$TMP_DIR/archive.tar.gz"; then
      if tar -xzf "$TMP_DIR/archive.tar.gz" -C "$TMP_DIR/src" --strip-components=1; then
        downloaded=1
        break
      fi
    fi
  done
  [ "$downloaded" -eq 1 ] || die "could not download $REPO_SLUG at $VERSION"

  mkdir -p "$(dirname "$BUKA_HOME")"
  BACKUP=""
  if [ -e "$BUKA_HOME" ]; then
    BACKUP="${BUKA_HOME}.old.$$"
    mv "$BUKA_HOME" "$BACKUP"
  fi
  if ! mv "$TMP_DIR/src" "$BUKA_HOME"; then
    if [ -n "$BACKUP" ]; then mv "$BACKUP" "$BUKA_HOME"; fi
    die "could not move the new install into $BUKA_HOME"
  fi
  if [ -n "$BACKUP" ]; then rm -rf "$BACKUP"; fi
  INSTALL_DIR="$BUKA_HOME"
fi

cd "$INSTALL_DIR"

say "Installing dependencies..."
if [ -f package-lock.json ]; then
  if ! npm ci --include=dev --no-audit --no-fund; then
    warn "npm ci failed; falling back to npm install"
    npm install --include=dev --no-audit --no-fund
  fi
else
  npm install --include=dev --no-audit --no-fund
fi

say "Building..."
npm run build --silent
[ -f dist/cli.js ] || die "build did not produce dist/cli.js"

NODE_BIN="$(command -v node)"

choose_bin_dir() {
  if [ -n "${BUKA_BIN_DIR:-}" ]; then
    mkdir -p "$BUKA_BIN_DIR" 2>/dev/null || die "cannot create BUKA_BIN_DIR: $BUKA_BIN_DIR"
    printf '%s\n' "$BUKA_BIN_DIR"
    return 0
  fi
  for dir in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    if [ -d "$dir" ] && [ -w "$dir" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done
  mkdir -p "$HOME/.local/bin" || die "cannot create $HOME/.local/bin"
  printf '%s\n' "$HOME/.local/bin"
}

BIN_DIR="$(choose_bin_dir)"
TARGET="$BIN_DIR/buka"

if { [ -e "$TARGET" ] || [ -L "$TARGET" ]; } && ! is_ours "$TARGET"; then
  die "$TARGET already exists and was not installed by buka-ai. Remove it or set BUKA_BIN_DIR."
fi

rm -f "$TARGET"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' "$MARKER"
  printf 'exec %q %q "$@"\n' "$NODE_BIN" "$INSTALL_DIR/dist/cli.js"
} > "$TARGET"
chmod +x "$TARGET"

ON_PATH=0
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *)
    case "$BIN_DIR" in
      "$HOME"/*)
        added=0
        for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
          [ -f "$rc" ] || continue
          if ! grep -qF "export PATH=\"$BIN_DIR:\$PATH\"" "$rc" 2>/dev/null; then
            {
              printf '\n# buka-ai installer\n'
              printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
            } >> "$rc"
            added=1
          fi
        done
        if [ "$added" -eq 1 ]; then
          warn "$BIN_DIR is not on PATH yet. Run: source ~/.bashrc (or open a new shell)"
        else
          warn "$BIN_DIR is not on PATH. Add it to your shell profile."
        fi
        ;;
      *)
        warn "$BIN_DIR is not on PATH. Add it to your PATH to run buka by name."
        ;;
    esac
    ;;
esac

INSTALLED_VERSION="$("$TARGET" --version 2>/dev/null || true)"
[ -n "$INSTALLED_VERSION" ] || die "installed launcher failed to run: $TARGET --version"

say ""
say "buka ai installed"
say "  command: $TARGET"
say "  version: $INSTALLED_VERSION"
say "  source:  $INSTALL_DIR"
say ""
if [ "$ON_PATH" -eq 1 ]; then
  say "Start it with: buka"
else
  say "Start it with: $TARGET"
fi
