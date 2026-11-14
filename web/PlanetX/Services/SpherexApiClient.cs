using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.WebUtilities;

namespace PlanetX.Services;

public sealed class SpherexApiException(string message, int statusCode = 502) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

/// <summary>Server-side replacement for the former browser api.js client.</summary>
public sealed class SpherexApiClient(HttpClient http)
{
    public static IReadOnlyList<string> CachedTargets { get; } = Array.AsReadOnly(new[]
    {
        "barnards-star", "wise-0855-0714", "eps-ind-b", "rw-aurigae", "r-draconis"
    });

    public string AbsoluteUrl(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) ||
            !Uri.TryCreate(http.BaseAddress!, path, out var url) ||
            (url.Scheme != "http" && url.Scheme != "https"))
            throw new SpherexApiException("Invalid image URL.");
        return url.AbsoluteUri;
    }

    private static void CheckTarget(string target)
    {
        if (!CachedTargets.Contains(target))
            throw new SpherexApiException("Unsupported cached target.", 400);
    }

    private static string Endpoint(string path, string target) =>
        QueryHelpers.AddQueryString(path, "target", target);

    public string GetDiffUrl(string target, int a = 0, int b = 1)
    {
        CheckTarget(target);
        if (a < 0 || b < 0 || a == b)
            throw new SpherexApiException("Difference indices must be distinct non-negative integers.", 400);
        return QueryHelpers.AddQueryString(Endpoint("diff", target), new Dictionary<string, string?>
        {
            ["a"] = a.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["b"] = b.ToString(System.Globalization.CultureInfo.InvariantCulture)
        });
    }

    private async Task<(byte[] Body, string? ContentType)> RequestAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await http.GetAsync(path, cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw new SpherexApiException($"API HTTP {(int)response.StatusCode}", (int)response.StatusCode);
            return (await response.Content.ReadAsByteArrayAsync(cancellationToken),
                response.Content.Headers.ContentType?.MediaType);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new SpherexApiException("API request timed out. Please retry.", 504);
        }
        catch (HttpRequestException)
        {
            throw new SpherexApiException("Unable to reach the upstream API.");
        }
    }

    private async Task<JsonNode> JsonAsync(string path, CancellationToken cancellationToken)
    {
        var (body, _) = await RequestAsync(path, cancellationToken);
        try { return JsonNode.Parse(body) ?? throw new JsonException(); }
        catch (JsonException) { throw new SpherexApiException("Invalid API JSON response."); }
    }

    private static JsonObject Object(JsonNode? node) => node as JsonObject
        ?? throw new SpherexApiException("Invalid API object response.");
    private static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    private static bool Number(JsonNode? node, out double number)
    {
        number = 0;
        return node is JsonValue value && value.TryGetValue<double>(out number) && double.IsFinite(number);
    }

    public Task<JsonNode> GetHealthAsync(CancellationToken ct = default) => JsonAsync("health", ct);

    public async Task<JsonArray> GetTargetsAsync(CancellationToken ct = default)
    {
        var data = await JsonAsync("targets", ct) as JsonArray
            ?? throw new SpherexApiException("Expected a target list.");
        var result = new JsonArray();
        foreach (var node in data)
        {
            var key = Text(Object(node)["key"]);
            if (key is null || !CachedTargets.Contains(key)) continue;
            var target = Object(node!.DeepClone());
            target["frames_url"] = "/api/spherex/" + Endpoint("frames", key);
            result.Add(target);
        }
        return result;
    }

    private void NormalizeOptionalImages(JsonObject item)
    {
        // Keep absent/null images and all scientific metadata intact.
        foreach (var key in new[] { "url", "png_url", "png_url_large", "png_url_native", "png_url_color", "webp_url" })
            if (item[key] is not null)
                item[key] = AbsoluteUrl(Text(item[key]));
    }

    private void NormalizeImage(JsonNode? node, bool includeUrl, bool required = true)
    {
        var item = Object(node);
        NormalizeOptionalImages(item);
        var url = Text(item["png_url"]) ?? Text(item["url"]) ?? Text(item["png_url_large"]);
        if (url is null)
        {
            if (required) throw new SpherexApiException("Missing image URL.");
            return;
        }
        item["png_url"] = url;
        if (includeUrl) item["url"] = url;
    }

    public async Task<JsonObject> GetFramesAsync(string target, CancellationToken ct = default)
    {
        CheckTarget(target);
        var data = Object(await JsonAsync(Endpoint("frames", target), ct));
        if (data["frames"] is not JsonArray frames || frames.Count == 0)
            throw new SpherexApiException("No frames returned.");
        foreach (var frame in frames)
        {
            NormalizeImage(frame, true);
            var item = Object(frame);
            item["hero_url"] = Text(item["png_url_color"]) ?? Text(item["png_url_large"]) ?? Text(item["url"]);
        }
        // frame_shape and large_shape remain backend values, including rectangular images.
        NormalizeOptionalImages(data);
        if (data["diffs"] is JsonArray diffs)
            foreach (var diff in diffs) NormalizeImage(diff, true);
        else data["diffs"] = new JsonArray();
        return data;
    }

    public async Task<JsonObject> GetSpectrumAsync(string target, CancellationToken ct = default)
    {
        CheckTarget(target);
        var data = Object(await JsonAsync(Endpoint("spectrum", target), ct));
        if (data["spectrum"] is not JsonArray spectrum)
            throw new SpherexApiException("Invalid spectrum response.");
        data["spectrum"] = new JsonArray(spectrum.OfType<JsonObject>()
            .Where(p => Number(p["wavelength_um"], out _) && Number(p["flux"], out _))
            .OrderBy(p => p["wavelength_um"]!.GetValue<double>())
            .Select(p => (JsonNode)p.DeepClone()).ToArray());
        return data;
    }

    public async Task<JsonObject> GetFramesByDetectorAsync(string target, CancellationToken ct = default)
    {
        CheckTarget(target);
        var data = Object(await JsonAsync(Endpoint("frames_by_detector", target), ct));
        if (data["detectors"] is not JsonArray detectors)
            throw new SpherexApiException("Invalid detector response.");
        foreach (var node in detectors) NormalizeImage(node, false, required: false);
        NormalizeOptionalImages(data);
        data["hero_url"] = Text(data["png_url_color"]);
        return data;
    }

    public async Task<JsonObject> GetFramesByBandAsync(string target, CancellationToken ct = default)
    {
        CheckTarget(target);
        var data = Object(await JsonAsync(Endpoint("frames_by_band", target), ct));
        if (data["bands"] is not JsonArray bands)
            throw new SpherexApiException("Invalid band response.");
        // Preserve band ordering, missing-data entries, wavelengths and quality flags.
        foreach (var band in bands) NormalizeOptionalImages(Object(band));
        NormalizeOptionalImages(data);
        return data;
    }

    public string GetBandsDemoUrl() => AbsoluteUrl("static/bands.html");

    public async Task<(byte[] Body, string ContentType)> GetDiffAsync(string target, int a = 0, int b = 1, CancellationToken ct = default)
    {
        var (body, contentType) = await RequestAsync(GetDiffUrl(target, a, b), ct);
        if (contentType?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) != true)
            throw new SpherexApiException("Expected a difference image.");
        return (body, contentType);
    }

    public async Task<JsonObject> ResolveNameAsync(string name, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new SpherexApiException("Enter a target name.", 400);
        var result = Object(await JsonAsync(QueryHelpers.AddQueryString("resolve", "name", name.Trim()), ct));
        if (!Number(result["ra"], out _) || !Number(result["dec"], out _))
            throw new SpherexApiException("Invalid coordinates returned.");
        return result;
    }
}
