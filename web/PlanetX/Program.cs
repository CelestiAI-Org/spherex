using PlanetX.Services;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddControllersWithViews();
builder.Services.AddHttpClient<SpherexApiClient>(client =>
{
    var baseUrl = builder.Configuration["SpherexApi:BaseUrl"];
    if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) ||
        (uri.Scheme != "http" && uri.Scheme != "https"))
        throw new InvalidOperationException("SpherexApi:BaseUrl must be an absolute HTTP(S) URL.");
    var timeout = builder.Configuration.GetValue<double>("SpherexApi:TimeoutSeconds", 30);
    if (!double.IsFinite(timeout) || timeout <= 0)
        throw new InvalidOperationException("SpherexApi:TimeoutSeconds must be positive and finite.");
    client.BaseAddress = uri;
    client.Timeout = TimeSpan.FromSeconds(timeout);
});

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
