using System.Text.Json.Nodes;

namespace PlanetX.Services;

/// <summary>A response produced from the offline copy: JSON, or image bytes for /diff.</summary>
public sealed record LocalAnswer(int Status, JsonNode? Json = null, string? FilePath = null);

/// <summary>
/// The offline copy of the science API: static_export/ (frames.json, spectrum.json, detectors.json, bands.json and
/// the WebP/PNG images per target, written by scripts/export_static.py) shipped inside the frontend image.
/// It answers the read endpoints for the cached demo targets exactly as the API does with SPHEREX_PREFER_STATIC=1,
/// so those targets keep working when the API is asleep or down. Image URLs in the JSON stay "/static/..." here;
/// the controller turns them into same-origin URLs served by <see cref="ImagePath"/>.
/// </summary>
public sealed class StaticExport
{
    private const double MaxMatchArcmin = 10.0;   // same as the API's MAX_MATCH_ARCMIN
    private static readonly HashSet<string> ImageExtensions = [".webp", ".png"];
    private readonly Dictionary<string, (string Name, double Ra, double Dec)> _targets = new();

    public string? Root { get; }
    public IReadOnlyCollection<string> Keys => _targets.Keys;

    public StaticExport(IConfiguration config, IWebHostEnvironment env, ILogger<StaticExport> log)
    {
        // Docker image: /app/static_export. `dotnet run` in web/PlanetX: the repo's static_export two levels up.
        string?[] candidates = [config["SpherexApi:StaticExportDir"],
            Path.Combine(env.ContentRootPath, "static_export"),
            Path.Combine(env.ContentRootPath, "..", "static_export"),
            Path.Combine(env.ContentRootPath, "..", "..", "static_export")];
        foreach (var dir in candidates)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
            foreach (var targetDir in Directory.EnumerateDirectories(dir))
            {
                try
                {
                    var frames = JsonNode.Parse(File.ReadAllText(Path.Combine(targetDir, "frames.json")))!;
                    _targets[Path.GetFileName(targetDir)] = ((string)frames["name"]!, (double)frames["ra"]!, (double)frames["dec"]!);
                }
                catch (Exception e) when (e is IOException or System.Text.Json.JsonException or InvalidOperationException or NullReferenceException) { }
            }
            if (_targets.Count == 0) continue;
            Root = Path.GetFullPath(dir);
            break;
        }
        if (Root is null) log.LogWarning("No static_export folder found: there is no offline copy if the SPHEREx API is down.");
        else log.LogInformation("Offline copy of the SPHEREx API: {Count} targets in {Root} ({Keys})", _targets.Count, Root, string.Join(", ", _targets.Keys));
    }

    /// <summary>Answers a read endpoint from the offline copy, or null if it cannot (unknown names for /resolve, /health).</summary>
    public LocalAnswer? Answer(string endpoint, IQueryCollection query)
    {
        if (Root is null) return null;
        if (endpoint == "targets") return new(200, Targets());
        if (endpoint == "resolve")
        {
            var hit = Find(query["name"].ToString());
            if (hit is null) return null;   // arbitrary names need the live name resolver
            var t = _targets[hit];
            return new(200, new JsonObject { ["name"] = t.Name, ["key"] = hit, ["ra"] = t.Ra, ["dec"] = t.Dec, ["source"] = "table", ["cached"] = true });
        }
        if (endpoint is not ("frames" or "spectrum" or "frames_by_detector" or "frames_by_band" or "diff")) return null;

        var (key, distance, error) = Pick(query);
        if (key is null) return new(error!.Value.Status, error.Value.Body);
        var dir = Path.Combine(Root, key);
        switch (endpoint)
        {
            case "frames":
                var frames = Read(dir, "frames.json")!;
                frames["matched_distance_arcmin"] = Math.Round(distance, 2);
                return new(200, frames);
            case "spectrum":
                var spectrum = Read(dir, "spectrum.json");
                if (spectrum is null) return new(404, Error($"No pre-computed spectrum for {key}"));
                if (bool.TryParse(query["exclude_saturated"], out var exclude) && exclude && spectrum["spectrum"] is JsonArray points)
                {
                    var kept = new JsonArray(points.Where(p => p?["saturated"]?.GetValue<bool>() != true).Select(p => p?.DeepClone()).ToArray());
                    spectrum["spectrum"] = kept;
                    spectrum["n_points"] = kept.Count;
                }
                return new(200, spectrum);
            case "frames_by_detector":
                return Read(dir, "detectors.json") is { } detectors ? new(200, detectors) : new(404, Error($"No pre-computed detector frames for {key}"));
            case "frames_by_band":
                return Read(dir, "bands.json") is { } bands ? new(200, bands)
                    : new(404, Error($"Band images were only pre-computed for some targets, not {key}"));
            default:   // diff: only consecutive visits were pre-rendered
                var file = int.TryParse(query["a"], out var a) && int.TryParse(query["b"], out var b)
                    ? ImageExtensions.Select(ext => Path.Combine(dir, $"diff_{a}_{b}{ext}")).FirstOrDefault(File.Exists) : null;
                return file is null ? new(404, Error("Only differences between consecutive frames (b = a + 1) are available offline")) : new(200, FilePath: file);
        }
    }

    /// <summary>Full path of an image under static_export for a "/static/..." relative path, or null if it is not one.</summary>
    public string? ImagePath(string relative)
    {
        if (Root is null || !ImageExtensions.Contains(Path.GetExtension(relative).ToLowerInvariant())) return null;
        var full = Path.GetFullPath(Path.Combine(Root, relative.TrimStart('/')));
        return full.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.Ordinal) && File.Exists(full) ? full : null;
    }

    private JsonArray Targets() => new(_targets.Select(pair =>
    {
        var dir = Path.Combine(Root!, pair.Key);
        var visits = (Read(dir, "frames.json")?["frames"] as JsonArray)?.Count ?? 0;
        return (JsonNode)new JsonObject
        {
            ["key"] = pair.Key, ["name"] = pair.Value.Name, ["ra"] = pair.Value.Ra, ["dec"] = pair.Value.Dec,
            ["visits"] = visits, ["source"] = "static", ["frames_url"] = $"/frames?target={pair.Key}",
            ["has_bands"] = File.Exists(Path.Combine(dir, "bands.json")),
        };
    }).ToArray());

    private (string? Key, double Distance, (int Status, JsonObject Body)? Error) Pick(IQueryCollection query)
    {
        var available = new JsonArray(_targets.Keys.Select(k => (JsonNode)k).ToArray());
        var target = query["target"].ToString();
        if (!string.IsNullOrWhiteSpace(target))
        {
            var key = Find(target);
            return key is null ? (null, 0, (404, Error($"Unknown or uncached target '{target}'", available))) : (key, 0, null);
        }
        if (!double.TryParse(query["ra"], System.Globalization.CultureInfo.InvariantCulture, out var ra)
            || !double.TryParse(query["dec"], System.Globalization.CultureInfo.InvariantCulture, out var dec))
            return (null, 0, (400, Error("Give either ?target=<key> or both ?ra= and ?dec=", available)));
        var (best, distance) = _targets.Select(p => (p.Key, Distance: SeparationArcmin(ra, dec, p.Value.Ra, p.Value.Dec)))
                                       .MinBy(p => p.Distance);
        return distance <= MaxMatchArcmin ? (best, distance, null)
            : (null, 0, (404, Error($"No cached target within {MaxMatchArcmin:0} arcmin of ra={ra}, dec={dec}", available)));
    }

    /// <summary>Key of a cached target from its key or name, ignoring case, spaces, apostrophes and dashes.</summary>
    private string? Find(string text)
    {
        static string Squash(string s) => new(s.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        var q = Squash(text);
        return q.Length == 0 ? null : _targets.FirstOrDefault(p => Squash(p.Key) == q || Squash(p.Value.Name) == q).Key;
    }

    private static double SeparationArcmin(double ra1, double dec1, double ra2, double dec2)
    {
        const double d = Math.PI / 180;
        var h = Math.Pow(Math.Sin((dec2 - dec1) * d / 2), 2) + Math.Cos(dec1 * d) * Math.Cos(dec2 * d) * Math.Pow(Math.Sin((ra2 - ra1) * d / 2), 2);
        return 2 * Math.Asin(Math.Min(1, Math.Sqrt(h))) / d * 60;
    }

    private static JsonNode? Read(string dir, string file)
    {
        var path = Path.Combine(dir, file);
        return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) : null;
    }

    private static JsonObject Error(string message, JsonArray? available = null)
    {
        var body = new JsonObject { ["error"] = message };
        if (available is not null) body["available_targets"] = available;
        return body;
    }
}
