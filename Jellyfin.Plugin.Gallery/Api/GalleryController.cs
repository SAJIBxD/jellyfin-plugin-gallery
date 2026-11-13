using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Gallery.Models;
using Jellyfin.Plugin.Gallery.Services;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Gallery.Api;

/// <summary>
/// API controller for serving gallery images.
/// </summary>
[ApiController]
[Authorize]
[Route("Gallery")]
public class GalleryController : ControllerBase
{
    // Image URLs carry the user's ApiKey, so responses are per-user: private caching only.
    private const string ImageCacheControl = "private, max-age=86400";

    private readonly ILibraryManager _libraryManager;
    private readonly GalleryCache _cache;
    private readonly GalleryThumbnailService _thumbnails;
    private readonly ILogger<GalleryController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="GalleryController"/> class.
    /// </summary>
    /// <param name="libraryManager">The Jellyfin library manager.</param>
    /// <param name="cache">The gallery cache.</param>
    /// <param name="thumbnails">The thumbnail service.</param>
    /// <param name="logger">The logger instance.</param>
    public GalleryController(
        ILibraryManager libraryManager,
        GalleryCache cache,
        GalleryThumbnailService thumbnails,
        ILogger<GalleryController> logger)
    {
        _libraryManager = libraryManager;
        _cache = cache;
        _thumbnails = thumbnails;
        _logger = logger;
    }

    private static string GalleryFolderName => Plugin.Instance?.Configuration.GalleryFolderName ?? "gallery";

    /// <summary>
    /// Gets the list of gallery images for a movie.
    /// </summary>
    /// <param name="itemId">The movie item identifier.</param>
    /// <response code="200">Gallery images returned successfully.</response>
    /// <response code="404">Item not found.</response>
    /// <returns>A list of gallery images.</returns>
    [HttpGet("{itemId}")]
    [Produces("application/json")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<IEnumerable<GalleryImage>> GetGalleryImages(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        if (item == null)
        {
            return NotFound(new { message = "Item not found." });
        }

        // Only movies are supported in this version.
        var moviePath = GetMovieFolderPath(item as Movie);
        if (moviePath == null)
        {
            return Ok(Array.Empty<GalleryImage>());
        }

        var images = _cache.GetGalleryImages(itemId, moviePath, GalleryFolderName);
        var basePath = $"{Request.PathBase}/Gallery/{itemId:N}/";

        var result = images.Select(img =>
        {
            var url = basePath + Uri.EscapeDataString(img.Name);
            return new GalleryImage
            {
                Name = img.Name,
                Url = url,
                ThumbnailUrl = $"{url}?width={GalleryThumbnailService.DefaultThumbnailWidth}"
            };
        });

        return Ok(result);
    }

    /// <summary>
    /// Serves a gallery image file, optionally downscaled.
    /// </summary>
    /// <param name="itemId">The movie item identifier.</param>
    /// <param name="imageName">The image file name.</param>
    /// <param name="width">Optional maximum width; returns a cached, downscaled thumbnail.</param>
    /// <param name="height">Optional maximum height; returns a cached, downscaled thumbnail.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Image file served successfully.</response>
    /// <response code="304">Image not modified.</response>
    /// <response code="404">Item or image not found.</response>
    /// <returns>The image file.</returns>
    [HttpGet("{itemId}/{imageName}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status304NotModified)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetGalleryImage(
        Guid itemId,
        string imageName,
        [FromQuery] int? width,
        [FromQuery] int? height,
        CancellationToken cancellationToken)
    {
        var moviePath = GetMovieFolderPath(_libraryManager.GetItemById(itemId) as Movie);
        if (moviePath == null)
        {
            return NotFound();
        }

        // Only names the scanner returned are servable: this blocks path
        // traversal and stops other files in the folder from being exposed.
        var image = _cache.FindImage(itemId, moviePath, GalleryFolderName, imageName);
        var file = image == null ? null : new FileInfo(image.Path);
        if (file == null || !file.Exists)
        {
            _logger.LogDebug("Gallery image not found: {Item}/{Name}", itemId, imageName);
            return NotFound();
        }

        var thumbnailPath = await _thumbnails.GetThumbnailAsync(file, width, height, cancellationToken).ConfigureAwait(false);
        if (thumbnailPath != null)
        {
            return ServeFile(new FileInfo(thumbnailPath), _thumbnails.ContentType);
        }

        var contentType = Path.GetExtension(file.Name).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            _ => "application/octet-stream"
        };

        return ServeFile(file, contentType);
    }

    private PhysicalFileResult ServeFile(FileInfo file, string contentType)
    {
        Response.Headers.CacheControl = ImageCacheControl;

        // PhysicalFile streams via sendfile where available and handles
        // If-None-Match / If-Modified-Since (304) and Range requests.
        var etag = new EntityTagHeaderValue($"\"{file.Length:x}-{file.LastWriteTimeUtc.Ticks:x}\"");
        return PhysicalFile(file.FullName, contentType, file.LastWriteTimeUtc, etag, enableRangeProcessing: true);
    }

    private static string? GetMovieFolderPath(Movie? movie)
    {
        if (movie == null || string.IsNullOrEmpty(movie.Path))
        {
            return null;
        }

        return Path.GetDirectoryName(movie.Path);
    }
}
