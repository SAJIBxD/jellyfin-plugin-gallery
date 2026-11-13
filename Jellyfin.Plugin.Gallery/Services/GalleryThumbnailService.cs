using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Model.Drawing;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Gallery.Services;

/// <summary>
/// Produces downscaled thumbnails for gallery images using Jellyfin's image
/// encoder, cached on disk so each size is only encoded once per file version.
/// </summary>
public sealed class GalleryThumbnailService : IDisposable
{
    /// <summary>
    /// Width requested by the web client for grid tiles. Large enough for a
    /// 3-column layout on a HiDPI screen, far smaller than camera originals.
    /// </summary>
    public const int DefaultThumbnailWidth = 800;

    private const int SizeStep = 100;
    private const int MinSize = 100;
    private const int MaxSize = 4000;
    private const int Quality = 85;

    private readonly IImageEncoder _encoder;
    private readonly ILogger<GalleryThumbnailService> _logger;
    private readonly string _cacheDir;
    private readonly ImageFormat _outputFormat;

    // Cache keys whose original is already within bounds (encoder declined to resize),
    // so we don't decode those images again on every request.
    private readonly ConcurrentDictionary<string, byte> _passthrough = new(StringComparer.Ordinal);

    // Skia encoding is CPU-heavy; cap parallel encodes so a gallery page with
    // dozens of tiles can't saturate the server.
    private readonly SemaphoreSlim _encodeLimiter = new(Math.Max(1, Environment.ProcessorCount / 2));

    /// <summary>
    /// Initializes a new instance of the <see cref="GalleryThumbnailService"/> class.
    /// </summary>
    /// <param name="encoder">Jellyfin's image encoder.</param>
    /// <param name="appPaths">The application paths.</param>
    /// <param name="logger">The logger instance.</param>
    public GalleryThumbnailService(IImageEncoder encoder, IApplicationPaths appPaths, ILogger<GalleryThumbnailService> logger)
    {
        _encoder = encoder;
        _logger = logger;
        _cacheDir = Path.Combine(appPaths.CachePath, "gallery-thumbs");
        _outputFormat = encoder.SupportedOutputFormats.Contains(ImageFormat.Webp) ? ImageFormat.Webp : ImageFormat.Jpg;
    }

    /// <summary>
    /// Gets the MIME type of generated thumbnails.
    /// </summary>
    public string ContentType => _outputFormat == ImageFormat.Webp ? "image/webp" : "image/jpeg";

    /// <summary>
    /// Returns the path of a thumbnail bounded by the given size, encoding it if needed.
    /// Returns <c>null</c> when no thumbnail is needed or possible — the caller
    /// should then serve the original file.
    /// </summary>
    /// <param name="source">The original image file.</param>
    /// <param name="maxWidth">Maximum thumbnail width.</param>
    /// <param name="maxHeight">Maximum thumbnail height.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The thumbnail path, or <c>null</c> to fall back to the original.</returns>
    public async Task<string?> GetThumbnailAsync(FileInfo source, int? maxWidth, int? maxHeight, CancellationToken cancellationToken)
    {
        if (!_encoder.SupportsImageEncoding || (maxWidth is null && maxHeight is null))
        {
            return null;
        }

        // Snap sizes to a coarse grid so arbitrary query values can't fill the disk cache.
        var width = Snap(maxWidth);
        var height = Snap(maxHeight);

        var cachePath = GetCachePath(source, width, height);
        if (_passthrough.ContainsKey(cachePath))
        {
            return null;
        }

        if (File.Exists(cachePath))
        {
            return cachePath;
        }

        await _encodeLimiter.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // Another request may have produced it while we waited.
            if (File.Exists(cachePath))
            {
                return cachePath;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(cachePath)!);
            var tempPath = cachePath + "." + Guid.NewGuid().ToString("N") + ".tmp";

            var options = new ImageProcessingOptions
            {
                MaxWidth = width,
                MaxHeight = height,
                Quality = Quality
            };

            var result = await Task.Run(
                () => _encoder.EncodeImage(source.FullName, source.LastWriteTimeUtc, tempPath, true, null, Quality, options, _outputFormat),
                cancellationToken).ConfigureAwait(false);

            // The encoder returns the input path untouched when the original is
            // already within bounds — just serve the original then.
            if (!string.Equals(result, tempPath, StringComparison.Ordinal) || !File.Exists(tempPath))
            {
                TryDelete(tempPath);
                _passthrough.TryAdd(cachePath, 0);
                return null;
            }

            File.Move(tempPath, cachePath, overwrite: true);
            return cachePath;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Gallery: failed to create thumbnail for {Path}; serving original", source.FullName);
            return null;
        }
        finally
        {
            _encodeLimiter.Release();
        }
    }

    /// <inheritdoc />
    public void Dispose() => _encodeLimiter.Dispose();

    private static int? Snap(int? size)
    {
        if (size is null or <= 0)
        {
            return null;
        }

        var rounded = (int)Math.Ceiling(size.Value / (double)SizeStep) * SizeStep;
        return Math.Clamp(rounded, MinSize, MaxSize);
    }

    private string GetCachePath(FileInfo source, int? width, int? height)
    {
        // Path + size + mtime in the key: editing or replacing a file yields a new thumbnail.
        var key = string.Join(
            '|',
            source.FullName,
            source.Length.ToString(CultureInfo.InvariantCulture),
            source.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture),
            width?.ToString(CultureInfo.InvariantCulture) ?? "-",
            height?.ToString(CultureInfo.InvariantCulture) ?? "-");

        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 16).ToLowerInvariant();
        var ext = _outputFormat == ImageFormat.Webp ? ".webp" : ".jpg";

        // Two-level fan-out keeps directory sizes manageable on large libraries.
        return Path.Combine(_cacheDir, hash[..2], hash + ext);
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
