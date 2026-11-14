using System.Net;
using System.Text;
using PlanetX.Services;

var handler = new StubHandler();
using var http = new HttpClient(handler) { BaseAddress = new Uri("https://upstream.example/") };
var api = new SpherexApiClient(http);
var checks = 0;
void Check(bool condition, string label)
{
    if (!condition) throw new Exception(label);
    checks++;
}
async Task Error(Func<Task> action, int status)
{
    try { await action(); }
    catch (SpherexApiException ex) { Check(ex.StatusCode == status, ex.Message); return; }
    throw new Exception($"Expected status {status}");
}
void Json(string body) => handler.Respond = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
{
    Content = new StringContent(body, Encoding.UTF8, "application/json")
});

Json("{\"ok\":true}");
Check((await api.GetHealthAsync())["ok"]!.GetValue<bool>(), "health");
Json("[{\"key\":\"barnards-star\"},{\"key\":\"unknown\"}]");
var targets = await api.GetTargetsAsync();
Check(targets.Count == 1 && targets[0]!["frames_url"]!.GetValue<string>() == "/api/spherex/frames?target=barnards-star", "target filtering and local URL");
Json("{\"frames\":[{\"png_url\":\"/img/one.png\",\"date\":\"2026\"}],\"diffs\":[{\"url\":\"img/diff.png\"}]}");
var frames = await api.GetFramesAsync("barnards-star");
Check(frames["frames"]![0]!["url"]!.GetValue<string>() == "https://upstream.example/img/one.png", "frame URL");
Check(frames["frames"]![0]!["date"]!.GetValue<string>() == "2026", "preserve metadata");
Check(frames["diffs"]![0]!["png_url"]!.GetValue<string>() == "https://upstream.example/img/diff.png", "diff URL");
Json("{\"frames\":[{\"url\":\"/img/one.png\"}]}");
Check((await api.GetFramesAsync("barnards-star"))["diffs"]!.AsArray().Count == 0, "missing diffs");
Json("{\"spectrum\":[{\"wavelength_um\":3,\"flux\":2},{\"wavelength_um\":1,\"flux\":5},{\"wavelength_um\":2,\"flux\":null},{\"wavelength_um\":\"4\",\"flux\":1}]}");
var spectrum = (await api.GetSpectrumAsync("barnards-star"))["spectrum"]!.AsArray();
Check(spectrum.Count == 2 && spectrum[0]!["wavelength_um"]!.GetValue<double>() == 1, "spectrum filtering and sort");
Json("{\"detectors\":[{\"url\":\"/a.png\",\"png_url_native\":\"/b.png\"}],\"png_url_color\":\"/c.png\"}");
var detectors = await api.GetFramesByDetectorAsync("barnards-star");
Check(detectors["detectors"]![0]!["png_url_native"]!.GetValue<string>() == "https://upstream.example/b.png" && detectors["png_url_color"]!.GetValue<string>() == "https://upstream.example/c.png", "detector URLs");
Json("{\"ra\":10,\"dec\":-5}");
await api.ResolveNameAsync("  A&B  ");
Check(handler.LastUri!.Query == "?name=A%26B", "encoded trimmed name");
await Error(async () => await api.ResolveNameAsync(" "), 400);
await Error(async () => await api.GetFramesAsync("unknown"), 400);
await Error(async () => await api.GetDiffAsync("barnards-star", 1, 1), 400);
Json("{\"frames\":[]}");
await Error(async () => await api.GetFramesAsync("barnards-star"), 502);
Json("{\"frames\":[{\"url\":\"javascript:bad\"}]}");
await Error(async () => await api.GetFramesAsync("barnards-star"), 502);
Json("{\"ra\":\"10\",\"dec\":5}");
await Error(async () => await api.ResolveNameAsync("test"), 502);
Json("not-json");
await Error(async () => await api.GetHealthAsync(), 502);
Json("{}");
await Error(async () => await api.GetDiffAsync("barnards-star"), 502);
handler.Respond = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
{
    Content = new ByteArrayContent([1, 2, 3]) { Headers = { ContentType = new("image/png") } }
});
var image = await api.GetDiffAsync("barnards-star", 0, 2);
Check(image.Body.SequenceEqual(new byte[] { 1, 2, 3 }) && image.ContentType == "image/png", "binary image");
Check(handler.LastUri!.Query.Contains("a=0&b=2"), "difference parameters");
handler.Respond = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
await Error(async () => await api.GetHealthAsync(), 404);
handler.Respond = (_, _) => throw new HttpRequestException("offline");
await Error(async () => await api.GetHealthAsync(), 502);
handler.Respond = (_, _) => throw new TaskCanceledException();
await Error(async () => await api.GetHealthAsync(), 504);
using var cancellation = new CancellationTokenSource();
handler.Respond = (_, ct) => { cancellation.Cancel(); ct.ThrowIfCancellationRequested(); throw new Exception(); };
try { await api.GetHealthAsync(cancellation.Token); throw new Exception("Cancellation lost"); }
catch (OperationCanceledException) { checks++; }

Json("""{"frame_shape":[292,310],"large_shape":[1024,1087],"fov_arcmin":15,"image_format":"webp","frames":[{"url":"/a.webp","png_url_large":"/large.webp","png_url_native":"/native.webp","png_url_color":"/color.webp","predicted_position":{"x":120,"y":80}}]}""");
var large = await api.GetFramesAsync("barnards-star");
Check(large["frame_shape"]![1]!.GetValue<int>() == 310 && large["large_shape"]![1]!.GetValue<int>() == 1087, "dynamic rectangular dimensions");
var hero = large["frames"]![0]!;
Check(hero["hero_url"]!.GetValue<string>() == "https://upstream.example/color.webp", "colour hero preferred");
Check(hero["png_url_large"]!.GetValue<string>() == "https://upstream.example/large.webp" && hero["png_url_native"]!.GetValue<string>() == "https://upstream.example/native.webp", "all image variants normalized");
Check(hero["predicted_position"]!["x"]!.GetValue<int>() == 120, "unknown motion metadata preserved (synthetic fixture)");
Json("""{"frames":[{"url":"/a.webp","png_url_color":null,"png_url_large":"/large.webp"}]}""");
Check((await api.GetFramesAsync("rw-aurigae"))["frames"]![0]!["hero_url"]!.GetValue<string>() == "https://upstream.example/large.webp", "hero fallback");
Json("""{"detectors":[{"png_url":null,"png_url_native":null,"note":"no coverage"}],"png_url_color":null}""");
Check((await api.GetFramesByDetectorAsync("eps-ind-b"))["detectors"]![0]!["png_url"] is null, "missing detector image accepted");
Json("""{"frame_shape":[292,292],"large_shape":[1024,1024],"bands":[{"band_index":0,"webp_url":"/bands/b0.webp","quality":"low","quality_notes":["noisy"]},{"band_index":1,"webp_url":null,"note":"no data"}]}""");
var bands = await api.GetFramesByBandAsync("barnards-star");
Check(handler.LastUri!.AbsolutePath == "/frames_by_band", "band endpoint");
Check(bands["bands"]![0]!["webp_url"]!.GetValue<string>() == "https://upstream.example/bands/b0.webp", "band URL");
Check(bands["bands"]![1]!["webp_url"] is null && bands["bands"]!.AsArray().Count == 2, "missing bands retain slider positions");
Check(bands["bands"]![0]!["quality"]!.GetValue<string>() == "low", "band quality preserved");
Json("{}");
await Error(async () => await api.GetFramesByBandAsync("barnards-star"), 502);
await Error(async () => await api.GetFramesByBandAsync("unknown"), 400);
Check(api.GetBandsDemoUrl() == "https://upstream.example/static/bands.html", "demo URL");
Console.WriteLine($"Passed {checks} API client checks.");

sealed class StubHandler : HttpMessageHandler
{
    public Uri? LastUri { get; private set; }
    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Respond { get; set; } = null!;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        LastUri = request.RequestUri;
        return Respond(request, ct);
    }
}
