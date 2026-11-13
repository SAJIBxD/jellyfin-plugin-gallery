using System;
using System.Collections.Generic;
using System.IO;
using Jellyfin.Plugin.Gallery.Models;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Gallery.Services;

/// <summary>
/// Scans movie folders for gallery images.
/// </summary>
public class GalleryScanner
{
    private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp"
    };

    private static readonly EnumerationOptions TopLevelOnly = new()
    {
        RecurseSubdirectories = false,
        IgnoreInaccessible = true,
        AttributesToSkip = FileAttributes.Hidden | FileAttributes.System
    };

    private readonly ILogger<GalleryScanner> _logger;

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
    /// <returns>A list of discovered gallery images, sorted by name.</returns>
    public List<GalleryImage> ScanGallery(string moviePath, string galleryFolderName)
    {
        var images = new List<GalleryImage>();

        if (string.IsNullOrEmpty(moviePath))
        {
            return images;
        }

        var galleryPath = Path.Combine(moviePath, galleryFolderName);

        try
        {
            if (!Directory.Exists(galleryPath))
            {
                _logger.LogDebug("Gallery folder not found at {Path}", galleryPath);
                return images;
            }

            foreach (var file in Directory.EnumerateFiles(galleryPath, "*", TopLevelOnly))
            {
                var name = Path.GetFileName(file);

                // Skip Apple Double resource-fork files (macOS creates these on
                // ExFAT / external volumes — they are NOT real images). The
                // extension filter already excludes .DS_Store and Thumbs.db.
                if (name.StartsWith("._", StringComparison.Ordinal)
                    || !SupportedExtensions.Contains(Path.GetExtension(name)))
                {
                    continue;
                }

                images.Add(new GalleryImage { Name = name, Path = file });
            }

            images.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));

            _logger.LogDebug("Found {Count} gallery image(s) in {Path}", images.Count, galleryPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error scanning gallery folder {Path}", galleryPath);
        }

        return images;
    }
}
