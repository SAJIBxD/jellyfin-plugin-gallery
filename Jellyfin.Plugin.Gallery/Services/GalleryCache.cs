using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
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
    /// Duration after which cached entries are considered stale.
    /// </summary>
    public TimeSpan CacheDuration { get; set; } = TimeSpan.FromMinutes(30);

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
    /// Gets gallery images for the specified item.
    /// Returns cached data if available and not expired; otherwise scans the filesystem.
    /// </summary>
    /// <param name="itemId">The Jellyfin item identifier.</param>
    /// <param name="moviePath">The filesystem path to the movie folder.</param>
    /// <param name="galleryFolderName">The name of the gallery folder.</param>
    /// <returns>A list of gallery images.</returns>
    public async Task<List<GalleryImage>> GetGalleryImagesAsync(
        Guid itemId,
        string moviePath,
        string galleryFolderName)
    {
        if (_cache.TryGetValue(itemId, out var cached) && !cached.IsExpired(CacheDuration))
        {
            _logger.LogDebug("Cache hit for item {ItemId}", itemId);
            return cached.Images;
        }

        _logger.LogDebug("Cache miss for item {ItemId}, scanning filesystem...", itemId);

        var images = await _scanner.ScanGalleryAsync(moviePath, galleryFolderName);

        _cache[itemId] = new CachedEntry
        {
            Images = images,
            CachedAt = DateTime.UtcNow
        };

        return images;
    }

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

    private sealed class CachedEntry
    {
        public List<GalleryImage> Images { get; init; } = new();
        public DateTime CachedAt { get; init; }

        public bool IsExpired(TimeSpan duration)
            => DateTime.UtcNow - CachedAt > duration;
    }
}
