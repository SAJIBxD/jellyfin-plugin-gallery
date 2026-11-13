using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using Jellyfin.Plugin.Gallery.Models;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Gallery.Services;

/// <summary>
/// In-memory cache for gallery image metadata that minimizes filesystem access
/// during page loads. Automatically refreshes after a configurable TTL.
/// </summary>
public class GalleryCache
{
    private readonly ConcurrentDictionary<Guid, CachedEntry> _cache = new();
    private readonly GalleryScanner _scanner;
    private readonly ILogger<GalleryCache> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="GalleryCache"/> class.
    /// </summary>
    /// <param name="scanner">The gallery scanner.</param>
    /// <param name="logger">The logger instance.</param>
    public GalleryCache(GalleryScanner scanner, ILogger<GalleryCache> logger)
    {
        _scanner = scanner;
        _logger = logger;
    }

    /// <summary>
    /// Gets or sets the duration after which cached entries are considered stale.
    /// </summary>
    public TimeSpan CacheDuration { get; set; } = TimeSpan.FromMinutes(30);

    /// <summary>
    /// Gets or sets the duration for empty results. Kept short so a gallery
    /// on a drive that was asleep / unmounted shows up again quickly.
    /// </summary>
    public TimeSpan EmptyCacheDuration { get; set; } = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Gets gallery images for the specified item.
    /// Returns cached data if available and not expired; otherwise scans the filesystem.
    /// </summary>
    /// <param name="itemId">The Jellyfin item identifier.</param>
    /// <param name="moviePath">The filesystem path to the movie folder.</param>
    /// <param name="galleryFolderName">The name of the gallery folder.</param>
    /// <returns>The gallery images, sorted by name.</returns>
    public IReadOnlyList<GalleryImage> GetGalleryImages(Guid itemId, string moviePath, string galleryFolderName)
        => GetEntry(itemId, moviePath, galleryFolderName).Images;

    /// <summary>
    /// Looks up a single gallery image by file name. Only files the scanner
    /// accepted (supported image types in the gallery folder) can be found.
    /// </summary>
    /// <param name="itemId">The Jellyfin item identifier.</param>
    /// <param name="moviePath">The filesystem path to the movie folder.</param>
    /// <param name="galleryFolderName">The name of the gallery folder.</param>
    /// <param name="name">The image file name.</param>
    /// <returns>The image, or <c>null</c> if it is not part of the gallery.</returns>
    public GalleryImage? FindImage(Guid itemId, string moviePath, string galleryFolderName, string name)
        => GetEntry(itemId, moviePath, galleryFolderName).ByName.GetValueOrDefault(name);

    /// <summary>
    /// Invalidates the cached entry for a specific item.
    /// </summary>
    /// <param name="itemId">The item identifier to invalidate.</param>
    public void Invalidate(Guid itemId)
    {
        if (_cache.TryRemove(itemId, out _))
        {
            _logger.LogDebug("Invalidated cache for item {ItemId}", itemId);
        }
    }

    private CachedEntry GetEntry(Guid itemId, string moviePath, string galleryFolderName)
    {
        // The folder name is part of the key so a config change takes effect
        // immediately instead of after the TTL.
        if (_cache.TryGetValue(itemId, out var cached)
            && !cached.IsExpired(cached.Images.Count == 0 ? EmptyCacheDuration : CacheDuration)
            && string.Equals(cached.FolderName, galleryFolderName, StringComparison.Ordinal))
        {
            return cached;
        }

        _logger.LogDebug("Cache miss for item {ItemId}, scanning filesystem", itemId);

        var images = _scanner.ScanGallery(moviePath, galleryFolderName);
        var byName = new Dictionary<string, GalleryImage>(images.Count, StringComparer.Ordinal);
        foreach (var image in images)
        {
            byName[image.Name] = image;
        }

        var entry = new CachedEntry(images, byName, galleryFolderName, DateTime.UtcNow);
        _cache[itemId] = entry;
        return entry;
    }

    private sealed record CachedEntry(
        IReadOnlyList<GalleryImage> Images,
        Dictionary<string, GalleryImage> ByName,
        string FolderName,
        DateTime CachedAt)
    {
        public bool IsExpired(TimeSpan duration) => DateTime.UtcNow - CachedAt > duration;
    }
}
