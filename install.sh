#!/usr/bin/env zsh
#
# install.sh — Build and install the Jellyfin Gallery Plugin on macOS
#
# Usage:
#   ./install.sh              # Build + install + restart Jellyfin
#   ./install.sh --no-restart # Build + install, but skip restart
#   ./install.sh --help       # Show this help
#
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
err()   { printf "${RED}[ERROR]${NC} %s\n" "$*"; }

# ─── Parse flags ──────────────────────────────────────────────────────────────
DO_RESTART=true
for arg in "$@"; do
    case "$arg" in
        --no-restart) DO_RESTART=false ;;
        --help|-h)
            cat <<'HELP'
install.sh — Build and install the Jellyfin Gallery Plugin on macOS

Usage:
  ./install.sh              # Build + install + restart Jellyfin
  ./install.sh --no-restart # Build + install, but skip restart
  ./install.sh --help       # Show this help
HELP
            exit 0
            ;;
        *) err "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ─── Resolve paths ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/Jellyfin.Plugin.Gallery"
PROJECT_FILE="$PROJECT_DIR/Jellyfin.Plugin.Gallery.csproj"
OUTPUT_DLL="$PROJECT_DIR/bin/Debug/net9.0/Jellyfin.Plugin.Gallery.dll"

# ─── 1. Find Jellyfin data directory ──────────────────────────────────────────
info "Looking for running Jellyfin process…"

JELLYFIN_PID=$(pgrep -x jellyfin 2>/dev/null || pgrep -x "Jellyfin Server" 2>/dev/null || true)

if [[ -n "$JELLYFIN_PID" ]]; then
    # Extract the --datadir argument from the process command line
    JELLYFIN_CMDLINE=$(ps -p "$JELLYFIN_PID" -o args= 2>/dev/null || true)

    # Extract --datadir <path> using sed (avoids zsh's `match` unbound-variable pitfall)
    JELLYFIN_DATA_DIR=$(echo "$JELLYFIN_CMDLINE" | sed -n 's/.*--datadir[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p')
fi

# Fallback: check common macOS Jellyfin data locations
if [[ -z "${JELLYFIN_DATA_DIR:-}" || ! -d "$JELLYFIN_DATA_DIR" ]]; then
    for dir in \
        "$HOME/.local/share/jellyfin" \
        "/opt/homebrew/var/lib/jellyfin" \
        "/usr/local/var/lib/jellyfin" \
        "/Applications/Jellyfin.app/Contents/Resources/jellyfin-web/../data" \
        ; do
        if [[ -d "$dir" ]]; then
            JELLYFIN_DATA_DIR="$dir"
            break
        fi
    done
fi

if [[ -z "${JELLYFIN_DATA_DIR:-}" || ! -d "$JELLYFIN_DATA_DIR" ]]; then
    err "Could not find Jellyfin data directory."
    err "Make sure Jellyfin is installed and has been run at least once."
    exit 1
fi
ok "Jellyfin data directory: $JELLYFIN_DATA_DIR"

PLUGIN_DIR="$JELLYFIN_DATA_DIR/plugins"

if [[ ! -d "$PLUGIN_DIR" ]]; then
    info "Creating plugins directory…"
    mkdir -p "$PLUGIN_DIR"
fi

# ─── 2. Build the plugin ──────────────────────────────────────────────────────
info "Building plugin (dotnet build)…"

if [[ ! -f "$PROJECT_FILE" ]]; then
    err "Project file not found at $PROJECT_FILE"
    exit 1
fi

BUILD_OUTPUT=$(cd "$PROJECT_DIR" && dotnet build -c Debug --nologo 2>&1) || {
    echo "$BUILD_OUTPUT"
    err "Build failed. See output above."
    exit 1
}

if [[ ! -f "$OUTPUT_DLL" ]]; then
    err "Build succeeded, but DLL not found at expected location:"
    err "  $OUTPUT_DLL"
    exit 1
fi
ok "Build successful: $OUTPUT_DLL"

# ─── 3. Copy DLL to plugins directory ─────────────────────────────────────────
# Jellyfin discovers plugins by enumerating subdirectories under the plugins folder.
# The plugin must be in its own subdirectory: plugins/Jellyfin.Plugin.Gallery/
PLUGIN_SUBDIR="$PLUGIN_DIR/Jellyfin.Plugin.Gallery"
TARGET_DLL="$PLUGIN_SUBDIR/Jellyfin.Plugin.Gallery.dll"
TARGET_DLL_BAK="${TARGET_DLL}.bak.$(date +%Y%m%d%H%M%S)"

# Clean up old root-level DLL if present (from previous installs)
if [[ -f "$PLUGIN_DIR/Jellyfin.Plugin.Gallery.dll" ]]; then
    info "Removing old root-level DLL (should be in subdirectory)…"
    rm "$PLUGIN_DIR/Jellyfin.Plugin.Gallery.dll"
fi

mkdir -p "$PLUGIN_SUBDIR"

if [[ -f "$TARGET_DLL" ]]; then
    info "Backing up existing DLL to $(basename "$TARGET_DLL_BAK")…"
    cp "$TARGET_DLL" "$TARGET_DLL_BAK"
    ok "Backup created."
fi

info "Installing plugin to $PLUGIN_SUBDIR…"
cp "$OUTPUT_DLL" "$TARGET_DLL"
ok "Plugin installed."

# ─── 3b. Deploy web files (gallery.js + index.html) ────────────────────────
info "Deploying web files…"

# Detect Jellyfin web root
JELLYFIN_APP="/Applications/Jellyfin.app"
if [[ -d "$JELLYFIN_APP" ]]; then
    WEB_ROOT="$JELLYFIN_APP/Contents/Resources/jellyfin-web"
else
    # Try to find from data dir (relative path)
    WEB_ROOT="$(dirname "$JELLYFIN_DATA_DIR")/jellyfin-web"
    if [[ ! -d "$WEB_ROOT" ]]; then
        warn "Could not detect jellyfin-web directory. Skipping web deployment."
        warn "You will need to manually copy Web/gallery.js to the jellyfin-web folder"
        warn "and add <script src=\"gallery.js\"></script> to index.html."
        SKIP_WEB=true
    fi
fi

if [[ "${SKIP_WEB:-false}" != true && -d "$WEB_ROOT" ]]; then
    ok "Web root: $WEB_ROOT"
    
    # Copy gallery.js
    SOURCE_JS="$PROJECT_DIR/Web/gallery.js"
    TARGET_JS="$WEB_ROOT/gallery.js"
    
    if [[ -f "$SOURCE_JS" ]]; then
        info "Copying gallery.js to web root…"
        cp "$SOURCE_JS" "$TARGET_JS"
        ok "gallery.js deployed."
    else
        warn "Source gallery.js not found at $SOURCE_JS. Skipping."
    fi
    
    # Inject <script> tag into index.html if not already present
    # Uses a cache-busting version parameter based on the current timestamp
    # so the browser always picks up the latest gallery.js after a deploy.
    INDEX_HTML="$WEB_ROOT/index.html"
    if [[ -f "$INDEX_HTML" ]]; then
        # Compute a cache-busting version string (Unix timestamp)
        GALLERY_VER=$(date +%s)
        if grep -q 'src="gallery.js"' "$INDEX_HTML" 2>/dev/null; then
            # Update existing reference with new cache-buster
            sed -i '' "s|src=\"gallery.js\"[^>]*|src=\"gallery.js?v=$GALLERY_VER\"|" "$INDEX_HTML"
            ok "gallery.js cache-buster updated to v=$GALLERY_VER."
        else
            info "Adding gallery.js reference to index.html…"
            # Insert before </body>
            sed -i '' "s|</body>|<script src=\"gallery.js?v=$GALLERY_VER\"></script>\n</body>|" "$INDEX_HTML"
            ok "index.html updated."
        fi
    else
        warn "index.html not found at $INDEX_HTML."
    fi
fi

ok "Web deployment complete."

# ─── 4. Restart Jellyfin ─────────────────────────────────────────────────────
if [[ "$DO_RESTART" == true ]]; then
    info "Restarting Jellyfin…"

    # Kill existing Jellyfin process
    # Kill ALL Jellyfin processes (both "jellyfin" and "Jellyfin Server")
    # to avoid port conflicts when relaunching.
    if pgrep -q -i jellyfin 2>/dev/null; then
        info "Stopping all Jellyfin processes…"
        pkill -f -i jellyfin 2>/dev/null || true

        # Wait for them to exit gracefully
        for i in {1..15}; do
            if ! pgrep -q -i jellyfin 2>/dev/null; then
                break
            fi
            sleep 1
        done

        # Force kill any survivors
        if pgrep -q -i jellyfin 2>/dev/null; then
            warn "Processes still alive after 15s, sending SIGKILL…"
            pkill -9 -f -i jellyfin 2>/dev/null || true
            sleep 2
        fi
        ok "Jellyfin stopped."
    fi

    # Relaunch via the .app bundle (using open ensures macOS TCC permissions
    # for external/removable volumes are handled correctly).
    JELLYFIN_APP="/Applications/Jellyfin.app"
    if [[ -d "$JELLYFIN_APP" ]]; then
        info "Starting Jellyfin from $JELLYFIN_APP…"
        open "$JELLYFIN_APP" --args --datadir "$JELLYFIN_DATA_DIR"
        ok "Jellyfin relaunched. Waiting for startup…"
        sleep 3
    else
        warn "Jellyfin.app not found at $JELLYFIN_APP."
        warn "Please start Jellyfin manually."
    fi
else
    info "Skipping restart (--no-restart flag)."
    info "Restart Jellyfin manually to load the new plugin."
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
ok "Installation complete!"
echo ""
echo "  Plugin : Jellyfin.Plugin.Gallery.dll"
echo "  Target : $PLUGIN_SUBDIR"
if [[ "$DO_RESTART" == true ]]; then
    echo "  Status : Installed and Jellyfin restarted."
else
    echo "  Status : Installed. Restart Jellyfin to activate."
fi
echo ""
