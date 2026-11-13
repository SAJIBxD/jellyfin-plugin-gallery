# Jellyfin Gallery Plugin

Adds a Gallery section to movie pages in Jellyfin. Put some images in a folder called `gallery` next to your movie, and they show up on that movie's page.

![Jellyfin 12](https://img.shields.io/badge/Jellyfin-12.x-00A4DC) ![.NET 10](https://img.shields.io/badge/.NET-10-512BD4)

## Setup

Each movie needs its own folder (the normal Jellyfin layout). Add a `gallery` folder inside it:

```
Movies/
└── Dune (2021)/
    ├── Dune (2021).mp4
    └── gallery/
        ├── still01.jpg
        └── bts.png
```

Supported formats are JPG, PNG and WebP. Only images directly inside `gallery/` are used; subfolders are ignored.

The Gallery section shows up below Scenes and above More Like This. Movies without a `gallery` folder look the same as before.

## Install

You need Jellyfin 12.

**From the plugin catalog (easiest):**

1. In Jellyfin, go to Dashboard → Plugins → Repositories and add this URL:
   `https://raw.githubusercontent.com/SAJIBxD/jellyfin-plugin-gallery/main/manifest.json`
2. Find **Gallery** in the Catalog tab and install it.
3. Restart Jellyfin.
4. Reload the Jellyfin page in your browser with `Ctrl+Shift+R` (`Cmd+Shift+R` on Mac).

**Manually:**

1. Download the zip from the [Releases](../../releases) page.
2. Unzip it into a folder called `Jellyfin.Plugin.Gallery` inside Jellyfin's `plugins` folder. That's usually:
   - Linux: `/var/lib/jellyfin/plugins/`
   - macOS: `~/.local/share/jellyfin/plugins/`
   - Windows: `%ProgramData%\Jellyfin\Server\plugins\`
   - Docker: `<your config folder>/plugins/`
3. Restart Jellyfin and reload the page like in step 4 above.

## Settings

Under Dashboard → Plugins → Gallery you can change the folder name it looks for. The default is `gallery`.

## Good to know

- To show the gallery, the plugin adds two `<script>` lines to Jellyfin's web `index.html` every time the server starts. Jellyfin updates replace that file, so this is how the gallery keeps working after an update.
- The page shows smaller versions of your images so it loads quickly. These are saved in Jellyfin's cache folder under `gallery-thumbs/`. It's safe to delete that folder at any time.
- New images can take up to 30 minutes to appear, because the plugin remembers each folder's contents for that long.
- macOS leftovers like `._image.jpg` files are skipped automatically.

## Uninstall

Stop Jellyfin and delete the plugin's folder from `plugins/`. You can also remove the two gallery lines from `jellyfin-web/index.html`, but if you leave them they don't break anything and go away on the next Jellyfin update.

## Building from source

```bash
dotnet build Jellyfin.Plugin.Gallery -c Release
```

Copy `Jellyfin.Plugin.Gallery/bin/Release/net10.0/Jellyfin.Plugin.Gallery.dll` into the plugin folder and restart Jellyfin. On macOS, `./install.sh` does the build, copy and restart for you (add `--no-restart` to skip the restart).

Where things live:

| Path | What it does |
|---|---|
| `Api/GalleryController.cs` | The `/Gallery` endpoints |
| `Services/GalleryScanner.cs` | Finds the images in a movie's folder |
| `Services/GalleryCache.cs` | Remembers scan results for 30 minutes |
| `Services/GalleryThumbnailService.cs` | Makes and caches the smaller images |
| `Services/WebAssetDeployer.cs` | Adds the script to `index.html` on startup |
| `Web/gallery.js` | The part that runs in the browser |

### API

Both endpoints need a Jellyfin login. For images, you can pass the key as `?ApiKey=...`.

- `GET /Gallery/{itemId}` returns the list of images for a movie.
- `GET /Gallery/{itemId}/{imageName}` returns one image. Add `?width=` or `?height=` to get a smaller copy.

## License

[MIT](LICENSE)
