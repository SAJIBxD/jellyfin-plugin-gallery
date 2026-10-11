# Jellyfin Gallery Plugin

Displays a **Gallery** section on movie details pages, sourced from a `gallery/` folder inside each movie directory. Pinterest-style Masonry layout, lazy loading, zero manual upkeep.

![Jellyfin 12](https://img.shields.io/badge/Jellyfin-12.x-00A4DC) ![.NET 10](https://img.shields.io/badge/.NET-10-512BD4)

## How it works

```
Movies/
└── Dune (2021)/
    ├── Dune (2021).mp4
    └── gallery/          ← any .jpg / .jpeg / .png / .webp
        ├── still01.jpg
        └── bts.png
```

- The plugin scans `<MovieFolder>/<GalleryFolderName>/` (top level only, no recursion).
- A **Gallery** section is injected on the movie details page, right after *Scenes* / before *More Like This*.
- macOS clutter (`._*` resource forks, `.DS_Store`) and `Thumbs.db` are ignored.
- Results are cached in memory for 30 minutes to avoid disk scans on every page load.
- **Survives Jellyfin updates**: Jellyfin wipes `jellyfin-web/` on every update. A startup service (`WebAssetDeployer`) re-deploys the web assets on each server start, so the gallery never silently disappears after an upgrade.

## Requirements

- Jellyfin server **12.x** (uses the .NET 10 runtime bundled with the server)
- Movies must be in their **own folders** (standard Jellyfin movie layout)

## Install

### Option A — release ZIP (recommended)

1. Download the latest `Jellyfin.Plugin.Gallery-v*.zip` from the [Releases](../../releases) page.
2. Extract it to a folder named `Jellyfin.Plugin.Gallery` inside your Jellyfin `plugins` directory:
   - Linux: `/var/lib/jellyfin/plugins/Jellyfin.Plugin.Gallery/`
   - macOS: `~/.local/share/jellyfin/plugins/Jellyfin.Plugin.Gallery/`
   - Windows: `%ProgramData%\Jellyfin\Server\plugins\Jellyfin.Plugin.Gallery\`
   - Docker: `<config>/plugins/Jellyfin.Plugin.Gallery/`
3. Restart Jellyfin. The web assets deploy automatically on startup — no extra steps.
4. Hard-refresh the web client once (`Ctrl+Shift+R` / `Cmd+Shift+R`).

### Option B — build from source

```bash
dotnet build Jellyfin.Plugin.Gallery -c Release
# copy bin/Release/net10.0/Jellyfin.Plugin.Gallery.dll
#   to <plugins>/Jellyfin.Plugin.Gallery/ and restart Jellyfin
```

macOS users can use the bundled script (builds, installs, deploys web files, restarts):

```bash
./install.sh              # full install + restart
./install.sh --no-restart # install only
```

## Configuration

Dashboard → **Plugins** → **Gallery**:

| Setting | Default | Description |
|---|---|---|
| Gallery Folder Name | `gallery` | Folder inside each movie directory that holds the images |

## API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /Gallery/{itemId}` | required | JSON list of gallery images for a movie |
| `GET /Gallery/{itemId}/{imageName}` | via `ApiKey` query param | Serves the image file |

## Uninstall

1. Stop Jellyfin, delete the `Jellyfin.Plugin.Gallery` folder from `plugins/`.
2. Optional cleanup: remove the two injected lines (`masonry-layout`, `plugins/Gallery/gallery.js`) from `jellyfin-web/index.html`. If left, they 404 harmlessly and are overwritten on the next Jellyfin update.

## Development

```bash
dotnet build Jellyfin.Plugin.Gallery -c Debug
```

- `Api/` — REST controllers
- `Services/GalleryScanner.cs` — filesystem scan
- `Services/GalleryCache.cs` — 30-minute in-memory cache
- `Services/WebAssetDeployer.cs` — startup self-heal for web assets
- `Web/gallery.js` — frontend (embedded resource, injected CSS + Masonry with CSS-column fallback)
- `Configuration/config.html` — plugin settings page (embedded resource)

## License

See [LICENSE](LICENSE).
