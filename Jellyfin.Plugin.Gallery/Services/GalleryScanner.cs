using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.Gallery.Models;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Gallery.Services;

/// <summary>
/// Scans movie folders for gallery images.
/// </summary>
public class GalleryScanner
{
    private readonly ILogger<GalleryScanner> _logger;

    private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp"
    };

    /// <summary>
    /// Initializes a new instance of the <see cref="GalleryScanner"/> class.
    /// </summary>
    /// <param name="logger">The logger instance.</param>
    public GalleryScanner(ILogger<GalleryScanner> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Scans a movie's folder for gallery images.
    /// Only scans the immediate contents of the gallery folder — does not recurse into subdirectories.
    /// </summary>
    /// <param name="moviePath">The filesystem path to the movie folder.</param>
    /// <param name="galleryFolderName">The name of the gallery folder to look for.</param>
    /// <returns>A list of discovered gallery images.</returns>
    public async Task<List<GalleryImage>> ScanGalleryAsync(string moviePath, string galleryFolderName)
    {
        var images = new List<GalleryImage>();

        if (string.IsNullOrEmpty(moviePath) || !Directory.Exists(moviePath))
        {
            return images;
        }

        var galleryPath = Path.Combine(moviePath, galleryFolderName);

        if (!Directory.Exists(galleryPath))
        {
            _logger.LogDebug("Gallery folder not found at {Path}", galleryPath);
            return images;
        }

        try
        {
            // Only enumerate the immediate directory contents — no recursion
            var files = Directory.EnumerateFiles(galleryPath, "*", SearchOption.TopDirectoryOnly)
                .Where(f =>
                {
                    // Only keep files with a supported image extension
                    if (!SupportedExtensions.Contains(Path.GetExtension(f)))
                        return false;

                    var name = Path.GetFileName(f);

                    // Skip Apple Double resource-fork files (macOS creates these
                    // on ExFAT / external volumes — they are NOT real images).
                    if (name.StartsWith("._"))
                        return false;

                    // Skip macOS .DS_Store
                    if (name == ".DS_Store")
                        return false;

                    // Skip Windows thumbnail cache
                    if (name == "Thumbs.db")
                        return false;

                    return true;
                })
                .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var file in files)
            {
                var image = new GalleryImage
                {
                    Name = Path.GetFileName(file),
                    Path = file,
                    Url = string.Empty,    // Constructed by the controller
                    ThumbnailUrl = string.Empty
                };
                images.Add(image);
            }

            _logger.LogInformation(
                "Found {Count} gallery image(s) in {Path}",
                images.Count,
                galleryPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error scanning gallery folder {Path}", galleryPath);
        }

        return images;
    }
}
