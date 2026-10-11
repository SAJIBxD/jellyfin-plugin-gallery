using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Gallery.Services;

/// <summary>
/// Self-healing web asset deployer.
///
/// Jellyfin replaces the entire jellyfin-web directory on every server update,
/// wiping the injected gallery.js and its index.html bootstrap. This hosted
/// service re-deploys both on every server start so the plugin survives
/// updates without manual re-installation.
/// </summary>
public sealed class WebAssetDeployer : IHostedService
{
    private const string ScriptSrc = "plugins/Gallery/gallery.js";
    private const string MasonrySrc = "https://unpkg.com/masonry-layout@4/dist/masonry.pkgd.min.js";
    private const string EmbeddedResourceName = "Jellyfin.Plugin.Gallery.Web.gallery.js";

    private readonly ILogger<WebAssetDeployer> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="WebAssetDeployer"/> class.
    /// </summary>
    /// <param name="logger">The logger instance.</param>
    public WebAssetDeployer(ILogger<WebAssetDeployer> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            Deploy();
        }
        catch (Exception ex)
        {
            // Never break server startup because of web asset deployment.
            _logger.LogWarning(ex, "Gallery web asset deployment failed; gallery UI may be unavailable until the next restart");
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private void Deploy()
    {
        var webRoot = FindWebRoot();
        if (string.IsNullOrEmpty(webRoot))
        {
            _logger.LogWarning("Gallery: jellyfin-web directory not found; skipping web asset deployment");
            return;
        }

        var script = ReadEmbeddedScript();
        if (string.IsNullOrEmpty(script))
        {
            _logger.LogWarning("Gallery: embedded gallery.js not found; skipping web asset deployment");
            return;
        }

        // Deterministic cache-buster: changes only when the script content changes.
        var version = ComputeVersion(script);

        var pluginDir = Path.Combine(webRoot, "plugins", "Gallery");
        Directory.CreateDirectory(pluginDir);

        var targetJs = Path.Combine(pluginDir, "gallery.js");
        WriteIfDifferent(targetJs, script, "gallery.js");

        PatchIndexHtml(Path.Combine(webRoot, "index.html"), version);
    }

    private void PatchIndexHtml(string indexPath, string version)
    {
        if (!File.Exists(indexPath))
        {
            _logger.LogWarning("Gallery: index.html not found at {Path}; skipping bootstrap injection", indexPath);
            return;
        }

        string html;
        try
        {
            html = File.ReadAllText(indexPath, Encoding.UTF8);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogWarning(ex, "Gallery: no permission to read {Path}; fix permissions or re-run install.sh", indexPath);
            return;
        }

        var expectedGalleryTag = $"<script src=\"{ScriptSrc}?v={version}\"></script>";
        var expectedMasonryTag = $"<script src=\"{MasonrySrc}\"></script>";

        // Already fully deployed with the current version — nothing to do.
        if (html.Contains(expectedGalleryTag, StringComparison.Ordinal)
            && html.Contains(expectedMasonryTag, StringComparison.Ordinal))
        {
            _logger.LogDebug("Gallery web assets already up to date (v={Version})", version);
            return;
        }

        // Drop any stale gallery/masonry references so exactly one ordered pair remains.
        html = Regex.Replace(html, @"<script src=""plugins/Gallery/gallery\.js[^""]*""></script>", string.Empty, RegexOptions.None);
        html = Regex.Replace(html, @"<script src=""gallery\.js[^""]*""></script>", string.Empty, RegexOptions.None);
        html = Regex.Replace(html, @"<script src=""https://unpkg\.com/masonry-layout[^""]*""></script>", string.Empty, RegexOptions.None);

        // Clean up empty lines the removals may have left behind.
        html = Regex.Replace(html, @"(?:\r?\n){3,}", "\n\n", RegexOptions.None);

        var bootstrap = expectedMasonryTag + "\n" + expectedGalleryTag + "\n";
        if (html.Contains("</body>", StringComparison.Ordinal))
        {
            html = html.Replace("</body>", bootstrap + "</body>", StringComparison.Ordinal);
        }
        else
        {
            html += "\n" + bootstrap;
        }

        try
        {
            File.WriteAllText(indexPath, html, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            _logger.LogInformation("Gallery web assets deployed to index.html (v={Version})", version);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogWarning(ex, "Gallery: no permission to write {Path}; fix permissions or re-run install.sh", indexPath);
        }
    }

    private void WriteIfDifferent(string path, string content, string label)
    {
        try
        {
            if (File.Exists(path))
            {
                var existing = File.ReadAllText(path, Encoding.UTF8);
                if (string.Equals(existing, content, StringComparison.Ordinal))
                {
                    return;
                }
            }

            File.WriteAllText(path, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            _logger.LogInformation("Gallery {Label} deployed", label);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogWarning(ex, "Gallery: no permission to write {Path}; fix permissions or re-run install.sh", path);
        }
    }

    private static string? ReadEmbeddedScript()
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream(EmbeddedResourceName);
        if (stream == null)
        {
            return null;
        }

        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static string ComputeVersion(string content)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        var sb = new StringBuilder(8);
        for (var i = 0; i < 4; i++)
        {
            sb.Append(hash[i].ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        }

        return sb.ToString();
    }

    private static string? FindWebRoot()
    {
        // Primary: the --webdir argument Jellyfin is always launched with.
        var args = Environment.GetCommandLineArgs();
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            string? candidate = null;
            if (arg.StartsWith("--webdir=", StringComparison.OrdinalIgnoreCase)
                || arg.StartsWith("-webdir=", StringComparison.OrdinalIgnoreCase))
            {
                candidate = arg.Substring(arg.IndexOf('=') + 1);
            }
            else if (string.Equals(arg, "--webdir", StringComparison.OrdinalIgnoreCase)
                || string.Equals(arg, "-webdir", StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 < args.Length)
                {
                    candidate = args[i + 1];
                }
            }

            if (!string.IsNullOrEmpty(candidate) && Directory.Exists(candidate))
            {
                return candidate;
            }
        }

        // Fallbacks for common install layouts (macOS .app bundle, Linux packages).
        var baseDir = AppContext.BaseDirectory;
        string[] fallbacks =
        [
            Path.GetFullPath(Path.Combine(baseDir, "..", "Resources", "jellyfin-web")),
            "/usr/share/jellyfin/web",
            Path.GetFullPath(Path.Combine(baseDir, "jellyfin-web")),
        ];

        foreach (var fallback in fallbacks)
        {
            if (Directory.Exists(fallback))
            {
                return fallback;
            }
        }

        return null;
    }
}
