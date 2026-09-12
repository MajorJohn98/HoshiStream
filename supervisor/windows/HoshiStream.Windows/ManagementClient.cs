using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace HoshiStream.Windows;

internal sealed record Credentials(int Port, string Token)
{
    public string Origin => $"http://127.0.0.1:{Port}";
    public string ManagementUrl => $"{Origin}/manage/{Uri.EscapeDataString(Token)}";
}

internal sealed record ServerSummary(int LibraryCount, double Speed, bool Streaming, bool PointerConfigured,
    bool PointerStale, bool WelcomePending, PointerDrift? Drift = null);

// The addon's automatic remote-record read (start-up and LAN change). Only
// "remote-mismatch" is surfaced as a balloon; the rest already shows in the menu.
internal sealed record PointerDrift(string Outcome, string CheckedAt, string? RemoteHost, string? LocalHost);

internal sealed class ManagementClient : IDisposable
{
    private readonly RuntimePaths paths;
    private readonly HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
    { Timeout = Timeout.InfiniteTimeSpan };

    public ManagementClient(RuntimePaths paths) => this.paths = paths;

    public Credentials ReadCredentials()
    {
        var path = Path.Combine(paths.State, ".env");
        if (new FileInfo(path).Length > 65_536) throw new InvalidDataException("Configuration is too large.");
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var line in File.ReadLines(path))
        {
            var text = line.Trim();
            if (text.StartsWith('#')) continue;
            var equals = text.IndexOf('=');
            if (equals < 1) continue;
            var value = text[(equals + 1)..].Trim();
            if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
                value = value[1..^1];
            values[text[..equals].Trim()] = value;
        }
        if (!values.TryGetValue("ACCESS_TOKEN", out var token) || token.Length is < 20 or > 512 || token.Any(char.IsControl))
            throw new InvalidDataException("Access token is not ready.");
        var port = 7001;
        if (values.TryGetValue("ADDON_PORT", out var configured)
            && (!int.TryParse(configured, out port) || port is < 1 or > 65535))
            throw new InvalidDataException("Invalid add-on port.");
        return new(port, token);
    }

    public async Task<ServerSummary?> PollAsync(int ownerPid, CancellationToken cancellation)
    {
        var controlPath = Path.Combine(paths.State, "run", "control.json");
        if (!File.Exists(controlPath)) return null;
        if (new FileInfo(controlPath).Length > 8192) throw new InvalidDataException("Invalid control metadata.");
        using var control = JsonDocument.Parse(await File.ReadAllTextAsync(controlPath, cancellation));
        var info = control.RootElement;
        if (info.GetProperty("version").GetInt32() != 1 || info.GetProperty("pid").GetInt32() != ownerPid)
            return null;
        var controlPort = info.GetProperty("port").GetInt32();
        var secret = info.GetProperty("secret").GetString();
        var instance = info.GetProperty("instance").GetString();
        if (controlPort is < 1 or > 65535 || secret is null || secret.Length != 64 || !secret.All(char.IsAsciiHexDigit)
            || instance is null || instance.Length != 48 || !instance.All(char.IsAsciiHexDigit))
            throw new InvalidDataException("Invalid control metadata.");
        using var readiness = await RequestAsync($"http://127.0.0.1:{controlPort}/status", HttpMethod.Get,
            secret, null, TimeSpan.FromSeconds(2), cancellation);
        var state = readiness.RootElement;
        if (state.GetProperty("version").GetInt32() != 1 || state.GetProperty("pid").GetInt32() != ownerPid
            || state.GetProperty("instance").GetString() != instance || !state.GetProperty("ready").GetBoolean()
            || state.GetProperty("stopping").GetBoolean()) return null;
        var credentials = ReadCredentials();
        if (state.GetProperty("addonPort").GetInt32() != credentials.Port) return null;
        using var ready = await RequestAsync($"{credentials.Origin}/ready", HttpMethod.Get, null, null,
            TimeSpan.FromSeconds(2), cancellation);
        if (ready.RootElement.GetProperty("status").GetString() != "ready") return null;
        using var status = await ApiAsync("/api/status", cancellation: cancellation);
        var root = status.RootElement;
        if (root.GetProperty("status").GetString() != "online") return null;
        var count = root.GetProperty("libraryCount").GetInt32();
        var speed = root.GetProperty("homeSpeedMbps").GetDouble();
        if (count < 0 || speed < 0 || !double.IsFinite(speed)) throw new InvalidDataException("Invalid status.");
        var pointer = root.GetProperty("pointer");
        var configured = pointer.GetProperty("configured").GetBoolean();
        var welcome = root.TryGetProperty("onboarding", out var onboarding)
            && onboarding.GetProperty("welcomePending").GetBoolean();
        return new(count, speed, root.GetProperty("streamingActive").GetBoolean(), configured,
            configured && pointer.TryGetProperty("stale", out var stale) && stale.GetBoolean(), welcome,
            configured ? ReadDrift(pointer) : null);
    }

    private static PointerDrift? ReadDrift(JsonElement pointer)
    {
        if (!pointer.TryGetProperty("drift", out var drift) || drift.ValueKind != JsonValueKind.Object) return null;
        var outcome = drift.TryGetProperty("outcome", out var o) ? o.GetString() : null;
        var checkedAt = drift.TryGetProperty("checkedAt", out var c) ? c.GetString() : null;
        if (outcome is null || checkedAt is null) return null;
        return new(outcome, checkedAt, Host(drift, "remoteBaseUrl"), Host(drift, "localBaseUrl"));
    }

    private static string? Host(JsonElement drift, string name) =>
        drift.TryGetProperty(name, out var value) && value.GetString() is { } url
            && Uri.TryCreate(url, UriKind.Absolute, out var parsed) ? parsed.Host : null;

    public Task<JsonDocument> ApiAsync(string path, HttpMethod? method = null, object? body = null,
        TimeSpan? timeout = null, CancellationToken cancellation = default)
    {
        var credentials = ReadCredentials();
        return RequestAsync(credentials.Origin + path, method ?? HttpMethod.Get, credentials.Token, body,
            timeout ?? TimeSpan.FromSeconds(5), cancellation);
    }

    private async Task<JsonDocument> RequestAsync(string url, HttpMethod method, string? token, object? body,
        TimeSpan timeout, CancellationToken cancellation)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(timeout);
        using var request = new HttpRequestMessage(method, url);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null)
            request.Content = new StringContent(JsonSerializer.Serialize(body, Contracts.Json), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > 512 * 1024) throw new InvalidDataException("Response too large.");
        await using var input = await response.Content.ReadAsStreamAsync(deadline.Token);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await input.ReadAsync(chunk, deadline.Token)) != 0)
        {
            if (buffer.Length + read > 512 * 1024) throw new InvalidDataException("Response too large.");
            buffer.Write(chunk, 0, read);
        }
        return JsonDocument.Parse(buffer.ToArray(), new JsonDocumentOptions { MaxDepth = 32 });
    }

    public bool MatchesManagementUrl(string value)
    {
        if (!Contracts.LoopbackManagementUrl(value)) return false;
        var credentials = ReadCredentials();
        var uri = new Uri(value);
        return uri.Port == credentials.Port
            && string.Equals(uri.AbsolutePath, new Uri(credentials.ManagementUrl).AbsolutePath, StringComparison.Ordinal);
    }

    public async Task<string> ManifestUrlAsync(CancellationToken cancellation)
    {
        using var pointer = await ApiAsync("/api/pointer/status", cancellation: cancellation);
        string url;
        if (pointer.RootElement.TryGetProperty("usable", out var usable) && usable.GetBoolean())
        {
            url = pointer.RootElement.GetProperty("manifestUrl").GetString() ?? throw new InvalidDataException("Missing pointer URL.");
        }
        else
        {
            var start = new ProcessStartInfo(paths.Node)
            { WorkingDirectory = paths.Root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add(Path.Combine(paths.Root, "scripts", "lan-ip.mjs"));
            using var helper = Process.Start(start) ?? throw new InvalidOperationException("LAN helper did not start.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(4));
            try
            {
                var stdout = ReadHelperAsync(helper.StandardOutput, timeout.Token);
                var stderr = ReadHelperAsync(helper.StandardError, timeout.Token);
                await helper.WaitForExitAsync(timeout.Token);
                var output = await stdout;
                await stderr;
                if (helper.ExitCode != 0) throw new InvalidDataException("LAN helper failed.");
                using var data = JsonDocument.Parse(output);
                var address = data.RootElement.GetProperty("address").GetString();
                if (!IPAddress.TryParse(address, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork
                    || !IsPrivate(ip.GetAddressBytes())) throw new InvalidDataException("No private LAN address.");
                var credentials = ReadCredentials();
                url = $"http://{ip}:{credentials.Port}/addon/{Uri.EscapeDataString(credentials.Token)}/manifest.json";
            }
            finally
            {
                if (!helper.HasExited)
                {
                    helper.Kill();
                    await helper.WaitForExitAsync(CancellationToken.None);
                }
            }
        }
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
            || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new InvalidDataException("Invalid manifest URL.");
        using var manifest = await RequestAsync(url, HttpMethod.Get, null, null, TimeSpan.FromSeconds(5), cancellation);
        if (manifest.RootElement.GetProperty("id").GetString() != "com.john.private-torrent-streamer")
            throw new InvalidDataException("Manifest not reachable.");
        return url;
    }

    private static bool IsPrivate(byte[] ip) => ip[0] == 10 || ip[0] == 172 && ip[1] is >= 16 and <= 31 || ip[0] == 192 && ip[1] == 168;
    private static async Task<string> ReadHelperAsync(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[8193];
        var total = 0;
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(total), cancellation)) > 0)
        {
            total += count;
            if (total == buffer.Length) throw new InvalidDataException("Helper output exceeded its limit.");
        }
        return new string(buffer, 0, total);
    }
    public void Dispose() => http.Dispose();
}
