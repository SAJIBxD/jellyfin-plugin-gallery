using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.Gallery.Models;
using Jellyfin.Plugin.Gallery.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Gallery.Api;

/// <summary>
/// API controller for serving gallery images.
/// </summary>
[ApiController]
[Route("Gallery")]
[Produces("application/json")]
public class GalleryController : ControllerBase
{
    private readonly ILibraryManager _libraryManager;
    private readonly GalleryCache _cache;
    private readonly ILogger<GalleryController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="GalleryController"/> class.
    /// </summary>
    /// <param name="libraryManager">The Jellyfin library manager.</param>
    /// <param name="cache">The gallery cache.</param>
    /// <param name="logger">The logger instance.</param>
    public GalleryController(
        ILibraryManager libraryManager,
        GalleryCache cache,
        ILogger<GalleryController> logger)
    {
        _libraryManager = libraryManager;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// Gets the list of gallery images for a movie.
    /// </summary>
    /// <param name="itemId">The movie item identifier.</param>
    /// <response code="200">Gallery images returned successfully.</response>
    /// <response code="404">Item not found.</response>
    /// <returns>A list of gallery images.</returns>
    [HttpGet("{itemId}")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IEnumerable<GalleryImage>>> GetGalleryImages(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        if (item == null)
        {
            return NotFound(new { message = "Item not found." });
        }

        // Only movies are supported in this version
        if (item is not Movie movie)
        {
            return Ok(Enumerable.Empty<GalleryImage>());
        }

        var moviePath = GetMovieFolderPath(movie);
        if (string.IsNullOrEmpty(moviePath))
        {
            _logger.LogWarning("Movie {ItemId} has no valid file path", itemId);
            return Ok(Enumerable.Empty<GalleryImage>());
        }

        var config = Plugin.Instance?.Configuration;
        var galleryFolderName = config?.GalleryFolderName ?? "gallery";

        var images = await _cache.GetGalleryImagesAsync(itemId, moviePath, galleryFolderName);

        var basePath = Request.PathBase;

        var result = images.Select(img => new GalleryImage
        {
            Name = img.Name,
            Path = img.Path,
            Url = $"{basePath}/Gallery/{itemId}/{Uri.EscapeDataString(img.Name)}",
            ThumbnailUrl = $"{basePath}/Gallery/{itemId}/{Uri.EscapeDataString(img.Name)}?width=256&height=256"
        });

        return Ok(result);
    }

    /// <summary>
    /// Serves a gallery image file.
    /// </summary>
    /// <param name="itemId">The movie item identifier.</param>
    /// <param name="imageName">The image file name.</param>
    /// <param name="width">Optional width for thumbnail generation (reserved for future use).</param>
    /// <param name="height">Optional height for thumbnail generation (reserved for future use).</param>
    /// <response code="200">Image file served successfully.</response>
    /// <response code="404">Item or image not found.</response>
    /// <returns>The image file.</returns>
    [HttpGet("{itemId}/{imageName}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetGalleryImage(
        Guid itemId,
        string imageName,
        [FromQuery] int? width,
        [FromQuery] int? height)
    {
        var item = _libraryManager.GetItemById(itemId);
        if (item == null)
        {
            return NotFound();
        }

        if (item is not Movie movie)
        {
            return NotFound();
        }

        var moviePath = GetMovieFolderPath(movie);
        if (string.IsNullOrEmpty(moviePath))
        {
            return NotFound();
        }

        var config = Plugin.Instance?.Configuration;
        var galleryFolderName = config?.GalleryFolderName ?? "gallery";

        // Prevent path traversal attacks
        var sanitizedName = Path.GetFileName(imageName);
        if (string.IsNullOrEmpty(sanitizedName))
        {
            return NotFound();
        }

        var galleryPath = Path.Combine(moviePath, galleryFolderName);
        var imagePath = Path.Combine(galleryPath, sanitizedName);

        if (!System.IO.File.Exists(imagePath))
        {
            _logger.LogWarning("Gallery image not found: {Path}", imagePath);
            return NotFound();
        }

        var extension = Path.GetExtension(imagePath).ToLowerInvariant();
        var contentType = extension switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            _ => "application/octet-stream"
        };

        // Future enhancement: use width/height params with IImageProcessor for server-side thumbnails.
        // For now, serve the full-resolution file and let the frontend handle sizing via CSS.

        var stream = new FileStream(
            imagePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 4096,
            useAsync: true);

        return File(stream, contentType);
    }

    /// <summary>
    /// Gets the parent folder path for a movie item.
    /// </summary>
    private static string? GetMovieFolderPath(Movie movie)
    {
        if (string.IsNullOrEmpty(movie.Path))
        {
            return null;
        }

        var parentDir = Path.GetDirectoryName(movie.Path);
        return parentDir;
    }
}
