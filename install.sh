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
OUTPUT_DLL="$PROJECT_DIR/bin/Debug/net10.0/Jellyfin.Plugin.Gallery.dll"

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
# NOTE: this step is now only for instant effect without a restart. The
# plugin's WebAssetDeployer hosted service re-deploys these files on every
# server start, so Jellyfin updates no longer break the gallery UI.
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
        warn "and add a <script> tag to index.html."
        SKIP_WEB=true
    fi
fi

if [[ "${SKIP_WEB:-false}" != true && -d "$WEB_ROOT" ]]; then
    ok "Web root: $WEB_ROOT"

    # Helper: copy with sudo fallback (the Jellyfin 12 installer leaves
    # jellyfin-web/plugins/ owned by root).
    web_cp() {
        if cp "$1" "$2" 2>/dev/null; then return 0; fi
        warn "Need elevated permissions to write $2 — trying sudo…"
        sudo cp "$1" "$2"
    }
    web_mkdir() {
        if mkdir -p "$1" 2>/dev/null; then return 0; fi
        warn "Need elevated permissions to create $1 — trying sudo…"
        sudo mkdir -p "$1"
    }
    web_sed() {
        # $1 = sed expression, $2 = file. Falls back to sudo for root-owned files.
        if sed -i '' "$1" "$2" 2>/dev/null; then return 0; fi
        warn "Need elevated permissions to patch $2 — trying sudo…"
        sudo sed -i '' "$1" "$2"
    }

    # Copy gallery.js into a dedicated plugin folder (survives alongside
    # other plugin assets; only index.html needs re-patching after updates)
    WEB_PLUGIN_DIR="$WEB_ROOT/plugins/Gallery"
    web_mkdir "$WEB_PLUGIN_DIR"

    SOURCE_JS="$PROJECT_DIR/Web/gallery.js"
    TARGET_JS="$WEB_PLUGIN_DIR/gallery.js"

    if [[ -f "$SOURCE_JS" ]]; then
        info "Copying gallery.js to $WEB_PLUGIN_DIR…"
        web_cp "$SOURCE_JS" "$TARGET_JS"
        ok "gallery.js deployed."
    else
        warn "Source gallery.js not found at $SOURCE_JS. Skipping."
    fi

    # Remove any stale web-root copy from older installs (keeps a single source)
    if [[ -f "$WEB_ROOT/gallery.js" ]]; then
        info "Removing stale web-root gallery.js from previous installs…"
        rm -f "$WEB_ROOT/gallery.js"
    fi

    # Inject <script> bootstrap into index.html if not already present
    # Uses a cache-busting version parameter based on the current timestamp
    # so the browser always picks up the latest gallery.js after a deploy.
    INDEX_HTML="$WEB_ROOT/index.html"
    SCRIPT_SRC="plugins/Gallery/gallery.js"
    MASONRY_SRC="https://unpkg.com/masonry-layout@4/dist/masonry.pkgd.min.js"
    if [[ -f "$INDEX_HTML" ]]; then
        # Ensure the Masonry.js CDN tag loads BEFORE gallery.js so
        # window.Masonry is ready synchronously (gallery.js also lazy-loads
        # it as fallback). Strip any existing tag first to enforce order
        # and avoid duplicates from previous installs.
        # NOTE: single-quoted sed fragments keep zsh from parsing
        # $VAR[...] as an array subscript.
        if grep -q "masonry.pkgd.min.js" "$INDEX_HTML" 2>/dev/null; then
            web_sed '/masonry\.pkgd\.min\.js/d' "$INDEX_HTML"
        fi
        info "Ensuring Masonry.js loads before gallery.js…"
        if grep -q "$SCRIPT_SRC" "$INDEX_HTML" 2>/dev/null; then
            web_sed 's|<script src="'${SCRIPT_SRC}'|<script src="'${MASONRY_SRC}'"></script>\n<script src="'${SCRIPT_SRC}'|' "$INDEX_HTML"
        else
            web_sed 's|</body>|<script src="'${MASONRY_SRC}'"></script>\n</body>|' "$INDEX_HTML"
        fi
        ok "Masonry.js load order ensured."
        # Compute a cache-busting version string (Unix timestamp)
        GALLERY_VER=$(date +%s)
        if grep -q "$SCRIPT_SRC" "$INDEX_HTML" 2>/dev/null; then
            # Update existing reference with new cache-buster
            # (pattern matches both bare src and src with existing ?v= param)
            # NOTE: single-quoted sed fragments keep zsh from parsing
            # $VAR[...] as an array subscript.
            web_sed 's|src="'${SCRIPT_SRC}'[^"]*"|src="'${SCRIPT_SRC}'?v='${GALLERY_VER}'"|' "$INDEX_HTML"
            ok "gallery.js cache-buster updated to v=$GALLERY_VER."
        elif grep -q 'src="gallery.js"' "$INDEX_HTML" 2>/dev/null; then
            # Migrate legacy web-root reference to the plugin folder
            web_sed 's|src="gallery.js[^"]*"|src="'${SCRIPT_SRC}'?v='${GALLERY_VER}'"|' "$INDEX_HTML"
            ok "Migrated legacy gallery.js reference to $SCRIPT_SRC (v=$GALLERY_VER)."
        else
            info "Adding gallery.js reference to index.html…"
            # Insert before </body>
            web_sed 's|</body>|<script src="'${SCRIPT_SRC}'?v='${GALLERY_VER}'"></script>\n</body>|' "$INDEX_HTML"
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
