using PlanetX.Services;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddControllersWithViews();
builder.Services.AddHttpClient("Spherex", client =>
{
    var url = builder.Configuration["SpherexApi:BaseUrl"] ?? "https://spherex-api-cpln.onrender.com/";
    if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https"))
        throw new InvalidOperationException("SpherexApi:BaseUrl must be an HTTP(S) URL.");
    client.BaseAddress = uri;
    // Per-attempt timeouts and retries are handled by SpherexUpstream (SpherexApi:AttemptTimeoutSeconds, default 90).
    client.Timeout = Timeout.InfiniteTimeSpan;
});
builder.Services.AddSingleton<SpherexUpstream>();
builder.Services.AddSingleton<StaticExport>();
builder.Services.AddHostedService<SpherexWarmup>();   // wakes the API as soon as the frontend starts

var app = builder.Build();

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseRouting();

app.UseAuthorization();

app.MapStaticAssets();
app.MapControllers();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}")
    .WithStaticAssets();


app.Run();
