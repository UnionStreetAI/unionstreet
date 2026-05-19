#!/usr/bin/env bash
# Union Street installer — bootstraps Bun (if needed) and installs the `us` CLI.
#
#   curl -fsSL https://unionstreet.ai/install.sh | bash
#   curl -fsSL https://unionstreet.ai/install | bash
#
# Pin a release:
#   US_VERSION=0.1.0 curl -fsSL https://unionstreet.ai/install.sh | bash
#
# From this repository before npm publish:
#   bash scripts/install.sh --dry-run
set -euo pipefail

US_VERSION="${US_VERSION:-latest}"
US_PACKAGE="@unionstreet/us"
BUN_MIN_MAJOR=1
BUN_MIN_MINOR=3
DRY_RUN=0
NO_MODIFY_PATH=0
INSTALL_METHOD="${US_INSTALL_METHOD:-global}"

usage() {
  cat <<'EOF'
Union Street installer

Usage:
  curl -fsSL https://unionstreet.ai/install.sh | bash
  bash install.sh [options]

Options:
  -h, --help           Show this help
  -n, --dry-run        Print actions without changing the system
  --no-modify-path     Do not append Bun's bin dir to shell rc files
  --version <ver>      Install @unionstreet/us version (default: latest)

Environment:
  US_VERSION           Same as --version (default: latest)
  US_INSTALL_METHOD    global (default) or bunx
  BUN_INSTALL          Bun install directory (default: ~/.bun)
  US_INSTALL_REPO      GitHub org/repo for release asset hints (UnionStreetAI/unionstreet)

After install:
  us doctor
  us setup
  us tui
EOF
}

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      -n|--dry-run) DRY_RUN=1; shift ;;
      --no-modify-path) NO_MODIFY_PATH=1; shift ;;
      --version)
        shift
        [ $# -gt 0 ] || die "--version requires a value"
        US_VERSION="$1"
        shift
        ;;
      *)
        die "unknown argument: $1 (try --help)"
        ;;
    esac
  done
}

detect_platform() {
  local os arch
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"
  case "$os" in
    Darwin) os="macos" ;;
    Linux) os="linux" ;;
    *)
      die "unsupported OS: $os (Union Street supports macOS and Linux)"
      ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      die "unsupported CPU architecture: $arch"
      ;;
  esac
  log "platform: ${os}-${arch}"
}

bun_version_string() {
  command -v bun >/dev/null 2>&1 || return 1
  bun --version 2>/dev/null | sed -E 's/^bun v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/' | head -n1
}

bun_version_ok() {
  local v="${1:-}"
  local major minor rest
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  [ "$major" -gt "$BUN_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$BUN_MIN_MAJOR" ] && [ "$minor" -ge "$BUN_MIN_MINOR" ]
}

ensure_bun() {
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  local current
  current="$(bun_version_string || true)"
  if [ -n "$current" ] && bun_version_ok "$current"; then
    log "bun $current (ok)"
    return 0
  fi

  if [ -n "$current" ]; then
    warn "bun $current is below required ${BUN_MIN_MAJOR}.${BUN_MIN_MINOR}.x; reinstalling via bun.sh"
  else
    log "bun not found; installing from https://bun.sh"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] curl -fsSL https://bun.sh/install | bash"
    return 0
  fi

  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"

  current="$(bun_version_string || true)"
  bun_version_ok "$current" || die "bun install finished but version check failed (got: ${current:-none})"
  log "bun $current"
}

path_contains() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_path() {
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  local bun_bin="$BUN_INSTALL/bin"
  if path_contains "$bun_bin"; then
    log "PATH already includes $bun_bin"
    return 0
  fi

  if [ "$NO_MODIFY_PATH" -eq 1 ]; then
    warn "add $bun_bin to your PATH, then open a new shell"
    return 0
  fi

  local line="export PATH=\"$bun_bin:\$PATH\" # unionstreet"
  local updated=0
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$rc" ] && grep -Fq "# unionstreet" "$rc" 2>/dev/null; then
      log "PATH hook already present in $rc"
      updated=1
      continue
    fi
    if [ -f "$rc" ] || [ "$rc" = "$HOME/.zshrc" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        log "[dry-run] append PATH hook to $rc"
      else
        printf '\n%s\n' "$line" >>"$rc"
        log "appended PATH hook to $rc"
      fi
      updated=1
    fi
  done

  if [ "$updated" -eq 0 ]; then
    warn "could not find a shell rc file; add $bun_bin to PATH manually"
  else
    warn "open a new terminal (or source your rc file) so \`us\` is on PATH"
  fi
}

install_us_global() {
  local spec="$US_PACKAGE"
  if [ "$US_VERSION" != "latest" ]; then
    spec="${US_PACKAGE}@${US_VERSION}"
  fi
  log "installing $spec (global)"
  run bun install -g "$spec"
}

install_us_bunx_wrapper() {
  local wrapper_dir="${US_WRAPPER_DIR:-$HOME/.local/bin}"
  local wrapper="$wrapper_dir/us"
  local spec="$US_PACKAGE"
  if [ "$US_VERSION" != "latest" ]; then
    spec="${US_PACKAGE}@${US_VERSION}"
  fi
  log "installing bunx wrapper at $wrapper"
  run mkdir -p "$wrapper_dir"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] write $wrapper"
    return 0
  fi
  cat >"$wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export BUN_INSTALL="\${BUN_INSTALL:-$HOME/.bun}"
export PATH="\$BUN_INSTALL/bin:\$PATH"
exec bunx $spec "\$@"
EOF
  chmod +x "$wrapper"
  if ! path_contains "$wrapper_dir"; then
    warn "add $wrapper_dir to your PATH"
  fi
}

verify_us() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] us --version"
    return 0
  fi
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v us >/dev/null 2>&1; then
    us --version || us --help | head -n1
    return 0
  fi
  warn "\`us\` is not on PATH yet; try: export PATH=\"\$HOME/.bun/bin:\$PATH\""
}

main() {
  parse_args "$@"
  detect_platform
  ensure_bun
  case "$INSTALL_METHOD" in
    global) install_us_global ;;
    bunx) install_us_bunx_wrapper ;;
    *) die "US_INSTALL_METHOD must be global or bunx (got: $INSTALL_METHOD)" ;;
  esac
  ensure_path
  verify_us
  log ""
  log "Union Street is installed."
  log "Next:"
  log "  us doctor"
  log "  us setup"
  log "  us tui"
}

main "$@"
