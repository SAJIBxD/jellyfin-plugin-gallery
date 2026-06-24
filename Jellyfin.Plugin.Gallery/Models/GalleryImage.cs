namespace Jellyfin.Plugin.Gallery.Models;

/// <summary>
/// Represents a single gallery image with metadata and URLs.
/// </summary>
public class GalleryImage
{
    /// <summary>
    /// Gets or sets the display name of the image (file name).
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the full-resolution URL for the image.
    /// </summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the thumbnail URL for the image.
    /// </summary>
    public string ThumbnailUrl { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the file system path to the image.
    /// </summary>
    public string Path { get; set; } = string.Empty;
}
