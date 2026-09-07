using System.IO.Pipes;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace HoshiStream.Windows;

internal static class SelfTests
{
    public static int Run()
    {
        static void Check(bool condition, string description)
        {
            if (!condition) throw new InvalidOperationException("Self-test failed: " + description);
        }
        Check(LaunchOptions.Parse([]).Activation.Command == "default", "default activation");
        Check(LaunchOptions.Parse(["--shutdown"]).Activation.Command == "shutdown", "shutdown activation");
        Check(LaunchOptions.Parse(["--open-library"]).Activation.Command == "open-library", "library activation");
        Check(LaunchOptions.Parse(["--ensure-running"]).Activation.Command == "ensure-running", "quiet broker activation");
        Check(LaunchOptions.Parse(["--activate-stdin"]).ActivateFromStdin, "private stdin activation");
        var customState = Path.Combine(Path.GetTempPath(), "HoshiStream custom state");
        Check(LaunchOptions.Parse(["--state-dir=" + customState, "--activate-stdin"]).StateDirectory == customState,
            "private activation selects custom state");
        Check(LaunchOptions.Parse(["--shutdown", "--state-dir=" + customState]).StateDirectory == customState,
            "shutdown selects custom state");
        Check(LaunchOptions.Parse(["--register-magnet"]).Activation.Command == "register-magnet", "register CLI");
        Check(LaunchOptions.Parse(["--unregister-integrations"]).Activation.Command == "unregister-integrations", "cleanup CLI");
        Check(!Contracts.ValidActivation(new(1, "unregister-integrations")), "cleanup is not an IPC action");
        var executable = Path.Combine(Path.GetTempPath(), "HoshiStream.exe");
        Check(IntegrationCommands.IsOwned([executable], executable, false), "owned login command");
        Check(IntegrationCommands.IsOwned([executable, "--state-dir=" + customState], executable, false), "owned custom login command");
        Check(IntegrationCommands.IsOwned([executable, "--magnet=%1"], executable, true), "owned magnet command");
        Check(!IntegrationCommands.IsOwned([executable + ".other"], executable, false), "foreign installation preserved");
        Check(!IntegrationCommands.IsOwned([executable, "--shutdown"], executable, false), "unexpected command preserved");
        Check(!IntegrationCommands.IsOwned([executable, "--state-dir=relative"], executable, false), "invalid ownership option preserved");
        Check(!IntegrationCommands.IsOwned([executable], executable, true), "missing magnet placeholder rejected");
        Check(LaunchOptions.Parse(["--open-url=http://127.0.0.1:7001/manage#/welcome"]).Activation.Command == "open-welcome", "tokenless compatibility");
        Check(Contracts.ValidMagnet("magnet:?xt=urn:btih:0123456789012345678901234567890123456789"), "magnet accepted");
        Check(!Contracts.ValidMagnet("https://example.org/"), "web URL is not a magnet");
        Check(!Contracts.ValidMagnet("magnet://example.org/?xt=invalid"), "magnet authority rejected");
        Check(!Contracts.ValidMagnet("magnet:?xt=x#fragment"), "magnet fragment rejected");
        Check(!Contracts.ValidMagnet("magnet:?xt=x\n"), "magnet control rejected");
        Check(!Contracts.ValidMagnet("magnet:?xt=" + new string('a', 16_384)), "magnet bound");
        Check(Contracts.LoopbackManagementUrl("http://127.0.0.1:7001/manage/token#/library"), "local management");
        foreach (var bad in new[]
        {
            "https://example.org/manage/token", "file:///manage/token", "http://127.0.0.1:7001/api/status",
            "http://127.0.0.1.evil.org/manage/token", "http://user@127.0.0.1/manage/token",
            "http://127.0.0.1/manage/token?magnet=x", "http://127.0.0.1\\evil/manage/token"
        })
            Check(!Contracts.LoopbackManagementUrl(bad), "management origin boundary");
        Check(!Contracts.ValidActivation(new Activation(2, "shutdown")), "activation version");
        Check(!Contracts.ValidActivation(new Activation(1, "shutdown", "unexpected")), "shutdown payload");
        Check(RuntimeDiagnostics.Classify("{\"event\":\"native_ready\",\"token\":\"do-not-log\"}") == "native_ready", "safe runtime event");
        Check(RuntimeDiagnostics.Classify("{\"event\":\"do-not-log\",\"magnet\":\"magnet:?xt=private\"}") is null, "unknown event discarded");
        Check(RuntimeDiagnostics.Classify("magnet:?xt=private") is null, "raw magnet discarded");
        Check(RuntimeDiagnostics.Classify("{\"event\":\"native_start_failed\",\"error\":\"Port 7001 is already in use. private details\"}")
            == "runtime_port_in_use", "safe preflight classification");
        Check(!RuntimeDiagnostics.ShouldRecover(0, null), "terminal stop stays stopped");
        Check(!RuntimeDiagnostics.ShouldRecover(1, "runtime_state_already_owned"), "state collision does not restart");
        Check(!RuntimeDiagnostics.ShouldRecover(1, "runtime_port_in_use"), "port collision does not restart");
        Check(RuntimeDiagnostics.ShouldRecover(1, null), "unexpected exit recovers");
        Check(RuntimeDiagnostics.ShouldRecover(null, null), "readiness timeout recovers");
        Check(WindowsCommandLine.QuoteArgument("") == "\"\"", "empty argument");
        Check(WindowsCommandLine.QuoteArgument("plain") == "\"plain\"", "plain argument");
        Check(WindowsCommandLine.QuoteArgument("a\"b") == "\"a\\\"b\"", "quoted argument");
        Check(WindowsCommandLine.QuoteArgument("C:\\folder with spaces\\") == "\"C:\\folder with spaces\\\\\"", "trailing slash");
        foreach (var arguments in new[]
        {
            new[] { "--unknown" }, new[] { "--shutdown", "--open-library" },
            new[] { "--open-url=https://example.org/manage/token" }, new[] { "--runtime-root=relative" },
            new[] { "--open-url=http://127.0.0.1:7001/manage/private-token" },
            new[] { "--activate-stdin", "--open-library" }, new[] { "--open-library", "--activate-stdin" },
            new[] { "--activate-stdin", "--activate-stdin" }, new[] { "--state-dir=relative" },
            new[] { "--state-dir=" + customState, "--state-dir=" + customState }
        })
        {
            var rejected = false;
            try { LaunchOptions.Parse(arguments); } catch (ArgumentException) { rejected = true; }
            Check(rejected, "invalid launch arguments");
        }
        VerifyPipeRecoveryAsync().GetAwaiter().GetResult();
        VerifyStdinActivationAsync().GetAwaiter().GetResult();
        VerifyResourceSamples();
        return 0;
    }

    private static void VerifyResourceSamples()
    {
        Dictionary<int, ProcessSample> first = new()
        {
            [100] = new(100, 1, "addon", 10_000_000, 1024, 100),
            [101] = new(101, 2, "torrServer", 20_000_000, 2048, 100)
        };
        Dictionary<int, ProcessSample> second = new()
        {
            [100] = new(100, 1, "addon", 15_000_000, 4096, 100 + Stopwatch.Frequency),
            [101] = new(101, 2, "torrServer", 22_500_000, 8192, 100 + Stopwatch.Frequency)
        };
        var report = ResourceSamples.Measure(first, second, 100);
        if (!report.Available || report.Addon is not { CpuPercent: 50, RssBytes: 4096, Processes: 1 }
            || report.TorrServer is not { CpuPercent: 25, RssBytes: 8192, Processes: 1 }
            || report.Ffmpeg is not { CpuPercent: 0, RssBytes: 0, Processes: 0 })
            throw new InvalidOperationException("Owned resource deltas were incorrect.");
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(report, Contracts.Json));
        if (json.RootElement.GetProperty("addon").GetProperty("processes").GetInt32() != 1
            || !json.RootElement.TryGetProperty("torrServer", out _)
            || !json.RootElement.TryGetProperty("ffmpeg", out _))
            throw new InvalidOperationException("Resource reply shape changed.");
        if (JsonSerializer.Serialize(new ResourceReport(false), Contracts.Json) != "{\"available\":false}")
            throw new InvalidOperationException("Unavailable resources fabricated usage fields.");
        if (ResourceSamples.Measure(first, second, 999).Available)
            throw new InvalidOperationException("An unrelated process was accepted.");
        second[100] = second[100] with { CreationTime = 3 };
        if (ResourceSamples.Measure(first, second, 100).Available)
            throw new InvalidOperationException("Reused process ID was accepted.");
        second[100] = second[100] with { CreationTime = 1, CpuTicks = 9_000_000 };
        if (ResourceSamples.Measure(first, second, 100).Available)
            throw new InvalidOperationException("A negative CPU delta was accepted.");
        second[100] = second[100] with { CpuTicks = 15_000_000, Timestamp = 100 };
        if (ResourceSamples.Measure(first, second, 100).Available)
            throw new InvalidOperationException("A zero sample interval was accepted.");
        second[100] = second[100] with { Timestamp = 100 + Stopwatch.Frequency };
        second[102] = new(102, 4, "ffmpeg", 0, 4096, 100 + Stopwatch.Frequency);
        if (ResourceSamples.Measure(first, second, 100).Available)
            throw new InvalidOperationException("An unsampled new process was reported as zero CPU.");
        second.Remove(102);
        second.Remove(101);
        if (ResourceSamples.Measure(first, second, 100).TorrServer is not { Processes: 0 })
            throw new InvalidOperationException("A confirmed exited group was not empty.");
    }

    private static async Task VerifyStdinActivationAsync()
    {
        using var input = new MemoryStream(Encoding.UTF8.GetBytes(
            "{\"version\":1,\"command\":\"open-url\",\"value\":\"http://127.0.0.1:7001/manage/private-token#/library\"}\n"));
        var activation = await Contracts.ReadStdinActivationAsync(input, CancellationToken.None);
        if (activation.Command != "open-url" || !activation.Value!.Contains("private-token", StringComparison.Ordinal))
            throw new InvalidOperationException("Stdin activation was not preserved.");
        foreach (var invalid in new[]
        {
            "{\"version\":1,\"command\":\"shutdown\"}\n",
            "{\"version\":1,\"command\":\"open-url\",\"value\":\"https://example.org/manage/private-token\"}\n"
        })
        {
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(invalid));
            var rejected = false;
            try { await Contracts.ReadStdinActivationAsync(stream, CancellationToken.None); }
            catch (InvalidDataException) { rejected = true; }
            if (!rejected) throw new InvalidOperationException("Unsafe stdin activation was accepted.");
        }
    }

    private static async Task VerifyPipeRecoveryAsync()
    {
        var name = "hs-" + Guid.NewGuid().ToString("N")[..16];
        var rejected = 0;
        using var server = new LocalPipeServer(name, _ => Interlocked.Increment(ref rejected), async (pipe, cancellation) =>
        {
            using var input = await PipeMessages.ReadAsync(pipe, 64, cancellation);
            if (!input.RootElement.TryGetProperty("kind", out var kind))
                throw new InvalidDataException("Invalid request.");
            if (kind.GetInt32() != 1) throw new InvalidDataException("Invalid kind.");
            await PipeMessages.WriteAsync(pipe, new { ok = true }, cancellation);
        });
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        foreach (var input in new[]
        {
            "{}\n", "{\"kind\":\"bad\"}\n", "{invalid}\n", new string('x', 66) + "\n",
            "{}\n", "{\"kind\":\"bad\"}\n", "{invalid}\n", new string('x', 66) + "\n",
            "{\"kind\":1}\n"
        })
        {
            using var client = new NamedPipeClientStream(".", name, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await client.ConnectAsync(deadline.Token);
            await client.WriteAsync(Encoding.UTF8.GetBytes(input), deadline.Token);
            if (input == "{\"kind\":1}\n")
            {
                using var response = await PipeMessages.ReadAsync(client, 64, deadline.Token);
                if (!response.RootElement.GetProperty("ok").GetBoolean())
                    throw new InvalidOperationException("Pipe listener did not recover.");
            }
            else if (await client.ReadAsync(new byte[1], deadline.Token) != 0)
                throw new InvalidOperationException("Invalid pipe request was accepted.");
        }
        if (rejected != 8) throw new InvalidOperationException("Pipe validation failures were not reported.");
    }
}
