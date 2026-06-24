using System;
using System.Collections.Generic;
using Jellyfin.Plugin.Gallery.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Gallery;

/// <summary>
/// The main plugin class for the Gallery plugin.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    private readonly ILogger<Plugin> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">The application paths.</param>
    /// <param name="xmlSerializer">The XML serializer.</param>
    /// <param name="logger">The logger instance.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _logger = logger;
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Gallery";

    /// <inheritdoc />
    public override string Description => "Displays gallery images from movie folders.";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("D2C8A4B6-7E3F-4A9B-8C1D-5F6E7A8B9C0D");

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        var prefix = GetType().Namespace + ".";

        return new[]
        {
            new PluginPageInfo
            {
                Name = "gallery_settings",
                EmbeddedResourcePath = prefix + "Configuration.config.html",
                EnableInMainMenu = true,
                MenuSection = "server",
                MenuIcon = "photo_library"
            }
        };
    }
}
