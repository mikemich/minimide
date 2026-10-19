#!/bin/sh
# Install or update Minimide.
#
#   curl -fsSL https://mikemich.github.io/minimide/install.sh | sh
#
# macOS: puts Minimide.app in /Applications (or ~/Applications if that isn't writable).
# Linux: puts the AppImage at ~/.local/bin/minimide and adds a menu entry.
# Set MINIMIDE_INSTALL_DIR to install somewhere else.
# Downloads come straight from the latest GitHub release over HTTPS and are checked
# against the SHA-256 digest GitHub publishes for each file.
set -eu

REPO="mikemich/minimide"
API="https://api.github.com/repos/$REPO/releases/latest"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

need curl
need uname

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Finding the latest release"
curl -fsSL -H "Accept: application/vnd.github+json" "$API" -o "$tmp/release.json" || die "could not reach GitHub"
version=$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$tmp/release.json" | head -n 1)
[ -n "$version" ] || die "could not read the latest version"

# Prints the download URL and sha256 digest ("url digest") of the asset with this exact name.
asset() {
  awk -v want="$1" '
    /"name":/ { n = $0; sub(/.*"name": *"/, "", n); sub(/".*/, "", n) }
    /"digest":/ { d = $0; sub(/.*"digest": *"(sha256:)?/, "", d); sub(/".*/, "", d); if (n == want) dig = d }
    /"browser_download_url":/ { u = $0; sub(/.*"browser_download_url": *"/, "", u); sub(/".*/, "", u); if (n == want) { print u, (dig ? dig : "-"); exit } }
  ' "$tmp/release.json"
}

fetch() { # name dest
  set -- "$1" "$2" $(asset "$1")
  [ $# -ge 3 ] || die "this release has no $1"
  say "Downloading $1"
  curl -fL --progress-bar "$3" -o "$2" || die "download failed"
  # Never install a file without the SHA-256 GitHub publishes for it.
  [ "${4:--}" != "-" ] || die "GitHub didn't publish a checksum for $1, so it can't be verified"
  if command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$2" | cut -d' ' -f1)
  else sum=$(sha256sum "$2" | cut -d' ' -f1); fi
  [ "$sum" = "$4" ] || die "checksum mismatch for $1 (expected $4, got $sum)"
}

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64) file="Minimide-$version-arm64-mac.zip" ;;
      *) file="Minimide-$version-mac.zip" ;;
    esac
    fetch "$file" "$tmp/minimide.zip"
    ditto -x -k "$tmp/minimide.zip" "$tmp/unzipped"
    [ -d "$tmp/unzipped/Minimide.app" ] || die "the download didn't contain Minimide.app"

    dest="${MINIMIDE_INSTALL_DIR:-/Applications}"
    [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
    if [ -z "${MINIMIDE_INSTALL_DIR:-}" ] && pgrep -xq Minimide; then
      say "Quitting the running Minimide"
      osascript -e 'tell application "Minimide" to quit' >/dev/null 2>&1 || true
      sleep 2
    fi
    rm -rf "$dest/Minimide.app"
    mv "$tmp/unzipped/Minimide.app" "$dest/Minimide.app"
    # Files downloaded with curl aren't quarantined, but clear the flag in case.
    xattr -dr com.apple.quarantine "$dest/Minimide.app" 2>/dev/null || true
    say "Installed Minimide $version to $dest/Minimide.app"
    printf '   Open it from Launchpad or run: open -a Minimide\n'
    ;;
  Linux)
    [ "$(uname -m)" = "x86_64" ] || die "prebuilt Linux builds are x86_64 only; build from source: https://github.com/$REPO"
    fetch "Minimide-$version.AppImage" "$tmp/minimide.AppImage"
    mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
    install -m 755 "$tmp/minimide.AppImage" "$HOME/.local/bin/minimide"
    cat > "$HOME/.local/share/applications/minimide.desktop" <<EOF
[Desktop Entry]
Name=Minimide
Comment=A small, hackable code editor
Exec=$HOME/.local/bin/minimide %F
Terminal=false
Type=Application
Categories=Development;TextEditor;
EOF
    say "Installed Minimide $version to ~/.local/bin/minimide"
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) printf '   Add ~/.local/bin to your PATH to run it as `minimide`.\n' ;; esac
    ;;
  *)
    die "use the Windows installer from https://github.com/$REPO/releases/latest"
    ;;
esac
