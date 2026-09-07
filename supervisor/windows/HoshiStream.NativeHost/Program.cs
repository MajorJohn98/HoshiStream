using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace HoshiStream.NativeHost;

internal static partial class Program
{
    private const string HostName = "com.hoshistream.chrome";
    private const string RegistryPath = @"Software\Google\Chrome\NativeMessagingHosts\" + HostName;
    private const int SmallFileLimit = 64_000;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args is ["--self-test"])
                return SelfTests.Run().GetAwaiter().GetResult();
            if (args is ["--self-test-idle-child"])
            {
                Console.Error.WriteLine("private-test-child-diagnostic");
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }
            string runtime = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
            if (args is ["--activate"])
            {
                Activate(runtime);
                return 0;
            }
            if (args.Length is < 1 or > 2 || !OriginPattern().IsMatch(args[0]) ||
                (args.Length == 2 && !ParentWindowPattern().IsMatch(args[1])))
                throw new InvalidDataException("Invalid native launch");
            string config = FindConfiguration(runtime, args[0]);
            return RunHost(runtime, config, args[0]).GetAwaiter().GetResult();
        }
        catch (Exception)
        {
            // Never include command arguments, local config, child stderr, or exceptions.
            Console.Error.WriteLine("{\"level\":\"error\",\"event\":\"browser_native_shim_failed\"}");
            return 1;
        }
    }

    private static string FindConfiguration(string runtime, string? origin)
    {
        string executable = Path.Combine(runtime, "native-host", "HoshiStream.NativeHost.exe");
        foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
        {
            using RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view);
            using RegistryKey? key = root.OpenSubKey(RegistryPath);
            if (key?.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not string path)
                continue;
            if (!LocalPath(path) || !Path.GetFileName(path).Equals(HostName + ".json", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Invalid manifest path");
            using JsonDocument manifest = ReadJson(path);
            JsonElement item = manifest.RootElement;
            if (item.GetProperty("name").GetString() != HostName ||
                item.GetProperty("type").GetString() != "stdio")
                throw new InvalidDataException("Invalid manifest");
            if (!SamePath(item.GetProperty("path").GetString(), executable))
                continue;
            string config = Path.Combine(Path.GetDirectoryName(path)!, "host-config.json");
            using JsonDocument settings = ReadJson(config);
            JsonElement data = settings.RootElement;
            string? extension = data.GetProperty("extensionId").GetString();
            if (extension is null || !ExtensionPattern().IsMatch(extension) ||
                data.GetProperty("version").GetInt32() != 2 ||
                data.GetProperty("platform").GetString() != "win32" ||
                !LocalPath(data.GetProperty("projectRoot").GetString()) ||
                !SamePath(data.GetProperty("appPath").GetString(), Path.Combine(runtime, "HoshiStream.exe")))
                throw new InvalidDataException("Invalid configuration");
            string expected = $"chrome-extension://{extension}/";
            JsonElement origins = item.GetProperty("allowed_origins");
            if (origins.GetArrayLength() != 1 || origins[0].GetString() != expected ||
                (origin is not null && origin.TrimEnd('/') != expected.TrimEnd('/')))
                throw new InvalidDataException("Unauthorized extension");
            return config;
        }
        throw new InvalidDataException("Register this installed native host first");
    }

    private static async Task<int> RunHost(string runtime, string config, string origin)
    {
        string node = Path.Combine(runtime, "bin", "node.exe");
        string host = Path.Combine(runtime, "addon", "dist", "browser", "host.js");
        if (!File.Exists(node) || !File.Exists(host)) throw new FileNotFoundException("Incomplete runtime");
        var start = new ProcessStartInfo(node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = runtime,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add(host);
        start.ArgumentList.Add(config);
        start.ArgumentList.Add(origin);
        start.Environment.Remove("NODE_OPTIONS");
        start.Environment.Remove("NODE_PATH");
        using Process child = Process.Start(start) ?? throw new InvalidOperationException("Host did not start");
        using Stream input = Console.OpenStandardInput();
        using Stream output = Console.OpenStandardOutput();
        return await RelayChild(child, input, output);
    }

    internal static async Task<int> RelayChild(Process child, Stream input, Stream output)
    {
        using var cancellation = new CancellationTokenSource();
        Task ingress = RelayFrames(input, child.StandardInput.BaseStream, 2_000_000, cancellation.Token);
        Task egress = RelayFrames(child.StandardOutput.BaseStream, output, 1_000_000, cancellation.Token);
        Task errors = DrainDiagnostics(child.StandardError.BaseStream, cancellation.Token);
        Task exit = child.WaitForExitAsync();
        try
        {
            Task finished = await Task.WhenAny(ingress, egress, exit);
            await finished;
            // Browser EOF cancels pending requests immediately, even if Node is waiting
            // on HTTP. Kill only this Node host, never a tray launched by Explorer.
            if (finished == ingress)
                return 0;
            await exit;
            await egress;
            await errors;
            return child.ExitCode;
        }
        finally
        {
            cancellation.Cancel();
            if (!child.HasExited)
            {
                try { child.Kill(); }
                catch (InvalidOperationException) when (child.HasExited) { }
            }
            await child.WaitForExitAsync();
            // Console pipe reads cannot always be cancelled on Windows; Main returning
            // releases the remaining handles after the owned child has exited.
            _ = ObserveCompletion(ingress);
            _ = ObserveCompletion(egress);
            _ = ObserveCompletion(errors);
        }
    }

    private static async Task ObserveCompletion(Task task)
    {
        try { await task; }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        catch (InvalidDataException) { }
    }

    internal static async Task RelayFrames(Stream input, Stream output, uint maximum, CancellationToken cancellation)
    {
        byte[] header = new byte[4];
        byte[] buffer = new byte[16_384];
        while (true)
        {
            int first = await input.ReadAsync(header.AsMemory(0, 1), cancellation);
            if (first == 0) return;
            await input.ReadExactlyAsync(header.AsMemory(1), cancellation);
            uint length = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(header);
            if (length < 2 || length > maximum) throw new InvalidDataException("Invalid native frame");
            await output.WriteAsync(header, cancellation);
            while (length > 0)
            {
                int count = (int)Math.Min(length, (uint)buffer.Length);
                await input.ReadExactlyAsync(buffer.AsMemory(0, count), cancellation);
                await output.WriteAsync(buffer.AsMemory(0, count), cancellation);
                length -= (uint)count;
            }
            await output.FlushAsync(cancellation);
        }
    }

    private static async Task DrainDiagnostics(Stream input, CancellationToken cancellation)
    {
        byte[] buffer = new byte[4096];
        bool reported = false;
        while (await input.ReadAsync(buffer, cancellation) != 0)
        {
            if (reported) continue;
            Console.Error.WriteLine("{\"level\":\"error\",\"event\":\"browser_native_node_diagnostic\"}");
            reported = true;
        }
    }

    private static void Activate(string runtime)
    {
        using Stream input = Console.OpenStandardInput();
        using JsonDocument request = ReadJson(input);
        JsonElement data = request.RootElement;
        if (data.GetProperty("version").GetInt32() != 1)
            throw new InvalidDataException("Invalid activation version");
        DesktopActivation activation;
        switch (data.GetProperty("command").GetString())
        {
            case "openLibrary" when data.EnumerateObject().Count() == 2:
                activation = new(1, "open-library");
                break;
            case "openUrl" when data.EnumerateObject().Count() == 3:
                string url = data.GetProperty("url").GetString() ?? "";
                if (!ValidEntryUrl(url)) throw new InvalidDataException("Invalid local entry URL");
                activation = new(1, "open-url", url);
                break;
            default:
                throw new InvalidDataException("Invalid activation command");
        }
        string app = Path.Combine(runtime, "HoshiStream.exe");
        if (!File.Exists(app)) throw new FileNotFoundException("Desktop app is unavailable");
        using JsonDocument config = ReadJson(FindConfiguration(runtime, null));
        string state = Path.TrimEndingDirectorySeparator(Path.GetFullPath(
            config.RootElement.GetProperty("projectRoot").GetString()!));
        // Explorer starts only a standalone, nonsecret broker target. The URL and
        // token go through the tray's bounded forward-only stdin mode, which owns
        // the current-user pipe and server-executable verification.
        ExplorerLauncher.Open(app, DesktopActivationLauncher.BrokerArguments(state), runtime);
        DesktopActivationLauncher.ForwardAsync(app, state, activation).GetAwaiter().GetResult();
    }

    internal static bool ValidEntryUrl(string value) =>
        value.Length <= 4096 && !value.Any(c => char.IsControl(c) || char.IsWhiteSpace(c) || c is '"' or '\\') &&
        Uri.TryCreate(value, UriKind.Absolute, out Uri? url) &&
        url.Scheme == "http" && url.Host == "127.0.0.1" &&
        url.UserInfo.Length == 0 && url.Query.Length == 0 &&
        EntryPathPattern().IsMatch(url.AbsolutePath) && EntryFragmentPattern().IsMatch(url.Fragment) &&
        value.StartsWith("http://127.0.0.1", StringComparison.Ordinal);

    private static JsonDocument ReadJson(string path)
    {
        using Stream input = File.OpenRead(path);
        return ReadJson(input);
    }

    private static JsonDocument ReadJson(Stream input)
    {
        byte[] bytes = new byte[SmallFileLimit + 1];
        int count = 0;
        while (count < bytes.Length)
        {
            int read = input.Read(bytes, count, bytes.Length - count);
            if (read == 0) return JsonDocument.Parse(bytes.AsMemory(0, count), new JsonDocumentOptions { MaxDepth = 16 });
            count += read;
        }
        throw new InvalidDataException("Input too large");
    }

    private static bool LocalPath(string? value) =>
        value is not null && value.Length <= 32_000 && LocalPathPattern().IsMatch(value) &&
        !value.Any(c => char.IsControl(c) || c is '"' or '<' or '>' or '|' or '?' or '*') &&
        !value.AsSpan(2).Contains(':');

    private static bool SamePath(string? left, string right) =>
        LocalPath(left) && Path.GetFullPath(left!).Equals(Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);

    [GeneratedRegex(@"\Achrome-extension://[a-p]{32}/?\z", RegexOptions.CultureInvariant)]
    private static partial Regex OriginPattern();
    [GeneratedRegex(@"\A--parent-window=[0-9]{1,20}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ParentWindowPattern();
    [GeneratedRegex(@"\A[a-p]{32}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ExtensionPattern();
    [GeneratedRegex(@"\A[a-zA-Z]:[\\/]", RegexOptions.CultureInvariant)]
    private static partial Regex LocalPathPattern();
    [GeneratedRegex(@"\A/manage/[^/]+\z", RegexOptions.CultureInvariant)]
    private static partial Regex EntryPathPattern();
    [GeneratedRegex(@"\A#/entry/[^/]+\z", RegexOptions.CultureInvariant)]
    private static partial Regex EntryFragmentPattern();
}
