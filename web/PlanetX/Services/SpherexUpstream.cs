using System.Net;

namespace PlanetX.Services;

public sealed record UpstreamResponse(HttpStatusCode Status, string? MediaType, byte[] Body);

/// <summary>The science API could not be reached after every retry.</summary>
public sealed class UpstreamUnavailableException(string reason) : Exception(reason);

/// <summary>
/// Calls the Python science API with retries. The API runs on Render's free plan, which sleeps when idle and
/// takes up to about a minute to wake, so every call gets a generous per-attempt timeout and is retried with
/// exponential backoff on connection errors, timeouts and 502/503/504 before anything is reported as failed.
/// Also remembers whether the API was failing recently, so the controller can answer from the offline copy
/// straight away instead of making every visitor wait through the retries again.
/// </summary>
public sealed class SpherexUpstream(IHttpClientFactory clients, IConfiguration config, ILogger<SpherexUpstream> log)
{
    private static readonly HashSet<HttpStatusCode> Transient =
        [HttpStatusCode.BadGateway, HttpStatusCode.ServiceUnavailable, HttpStatusCode.GatewayTimeout];
    private long _lastSuccess, _lastFailure;   // Environment.TickCount64 of the last outcome (0 = never)
    private int _waking;

    public TimeSpan AttemptTimeout => TimeSpan.FromSeconds(config.GetValue("SpherexApi:AttemptTimeoutSeconds", 90.0));
    public int Retries => config.GetValue("SpherexApi:Retries", 3);
    /// <summary>For endpoints the offline copy can answer: how long to wait for the API before using it.</summary>
    public TimeSpan LocalFallbackAfter => TimeSpan.FromSeconds(config.GetValue("SpherexApi:LocalFallbackAfterSeconds", 10.0));
    public Uri BaseAddress => clients.CreateClient("Spherex").BaseAddress!;

    /// <summary>True if the last call failed (after its retries) within the past minute and nothing has succeeded since.</summary>
    public bool RecentlyDown
    {
        get
        {
            long failure = Interlocked.Read(ref _lastFailure), success = Interlocked.Read(ref _lastSuccess);
            return failure > success && Environment.TickCount64 - failure < 60_000;
        }
    }

    /// <summary>The API did not answer in time for a visitor: treat it as down until a call succeeds again.</summary>
    public void MarkSlow() => Interlocked.Exchange(ref _lastFailure, Environment.TickCount64);

    public async Task<UpstreamResponse> GetAsync(string relativeUrl, CancellationToken ct)
    {
        var client = clients.CreateClient("Spherex");
        for (var attempt = 0; ; attempt++)
        {
            string reason;
            using (var attemptCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                attemptCts.CancelAfter(AttemptTimeout);
                try
                {
                    using var response = await client.GetAsync(relativeUrl, attemptCts.Token);
                    if (!Transient.Contains(response.StatusCode))
                    {
                        var body = await response.Content.ReadAsByteArrayAsync(attemptCts.Token);
                        if ((int)response.StatusCode < 500) Interlocked.Exchange(ref _lastSuccess, Environment.TickCount64);
                        else Interlocked.Exchange(ref _lastFailure, Environment.TickCount64);
                        return new(response.StatusCode, response.Content.Headers.ContentType?.MediaType, body);
                    }
                    reason = $"HTTP {(int)response.StatusCode}";
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { reason = $"no answer within {AttemptTimeout.TotalSeconds:0} s"; }
                catch (HttpRequestException e) { reason = e.Message; }
            }
            if (attempt >= Retries)
            {
                Interlocked.Exchange(ref _lastFailure, Environment.TickCount64);
                log.LogWarning("SPHEREx API {Url} failed after {Attempts} attempts: {Reason}", relativeUrl, attempt + 1, reason);
                throw new UpstreamUnavailableException(reason);
            }
            var delay = TimeSpan.FromSeconds(Math.Pow(2, attempt));   // 1 s, 2 s, 4 s, ...
            log.LogInformation("SPHEREx API {Url} attempt {Attempt} failed ({Reason}); retrying in {Delay} s", relativeUrl, attempt + 1, reason, delay.TotalSeconds);
            await Task.Delay(delay, ct);
        }
    }

    /// <summary>Starts a /health call in the background (at most one at a time) so a sleeping API begins to wake.</summary>
    public void WakeInBackground()
    {
        if (Interlocked.Exchange(ref _waking, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var started = Environment.TickCount64;
                await GetAsync("health", CancellationToken.None);
                log.LogInformation("SPHEREx API is awake ({Seconds:0.0} s)", (Environment.TickCount64 - started) / 1000.0);
            }
            catch (Exception e) { log.LogWarning("SPHEREx API warm-up failed: {Message}", e.Message); }
            finally { Interlocked.Exchange(ref _waking, 0); }
        });
    }
}

/// <summary>Wakes the science API as soon as the frontend starts, so it is up by the time a visitor asks for data.</summary>
public sealed class SpherexWarmup(SpherexUpstream upstream) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) { upstream.WakeInBackground(); return Task.CompletedTask; }
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
