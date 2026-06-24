using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Gallery.Configuration;

/// <summary>
/// Configuration for the Gallery plugin.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the name of the folder inside movie directories that contains gallery images.
    /// </summary>
    public string GalleryFolderName { get; set; } = "gallery";
}
