using System.Buffers.Binary;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;

namespace HoshiStream.NativeHost;

// Dependency-free transport checks. Only a dedicated idle fixture child is
// launched; no registry or desktop changes. Framework-dependent builds run on Mac.
internal static class SelfTests
{
    internal static async Task<int> Run()
    {
        byte[] body = new byte[100_003];
        for (int index = 0; index < body.Length; index++) body[index] = (byte)(index % 256);
        byte[] framed = new byte[body.Length + 4];
        BinaryPrimitives.WriteUInt32LittleEndian(framed, (uint)body.Length);
        body.CopyTo(framed, 4);
        using var input = new SplitStream(framed);
        using var output = new MemoryStream();
        await Program.RelayFrames(input, output, 1_000_000, CancellationToken.None);
        Require(framed.SequenceEqual(output.ToArray()), "Binary framing changed bytes");
        foreach (byte[] invalid in new[]
        {
            new byte[] { 1, 0, 0, 0 },
            new byte[] { 0xff, 0xff, 0xff, 0xff },
            new byte[] { 3, 0 },
            new byte[] { 3, 0, 0, 0, 65, 66 },
        })
        {
            bool rejected = false;
            try
            {
                await Program.RelayFrames(new MemoryStream(invalid), Stream.Null, 1_000_000, CancellationToken.None);
            }
            catch (InvalidDataException) { rejected = true; }
            catch (EndOfStreamException) { rejected = true; }
            Require(rejected, "Malformed frame accepted");
        }
        string valid = "http://127.0.0.1:7001/manage/test-token#/entry/hoshi%3Aexample";
        Require(Program.ValidEntryUrl(valid), "Local entry URL rejected");
        foreach (string invalid in new[]
        {
            valid.Replace("127.0.0.1", "localhost"),
            valid.Replace("127.0.0.1", "127.1"),
            valid.Replace("http:", "https:"),
            valid.Replace("127.0.0.1", "owner@127.0.0.1"),
            valid.Replace("#/entry", "?unsafe=1#/entry"),
            valid + "\" --shutdown",
            valid + "\\unsafe",
            valid + "\n",
            "magnet:?xt=private",
            "file:///C:/Windows/System32/cmd.exe",
        }) Require(!Program.ValidEntryUrl(invalid), "Unsafe entry URL accepted");
        Require(ExplorerLauncher.QuoteArgument(@"--state-dir=C:\Users\Owner's & Name\State") ==
            "\"--state-dir=C:\\Users\\Owner's & Name\\State\"", "State path quoting failed");
        Require(ExplorerLauncher.QuoteArgument(@"--state-dir=C:\") == "\"--state-dir=C:\\\\\"",
            "Trailing backslash quoting failed");
        PrivateNavigation(valid);
        await BrowserEofStopsChild();
        Console.Error.WriteLine("{\"event\":\"browser_native_self_test_passed\"}");
        return 0;
    }

    private static void Require(bool condition, string reason)
    {
        if (!condition) throw new InvalidOperationException(reason);
    }

    private static void PrivateNavigation(string url)
    {
        byte[] payload = DesktopActivationLauncher.Payload(new(1, "open-url", url));
        using JsonDocument request = JsonDocument.Parse(payload);
        Require(request.RootElement.GetProperty("value").GetString() == url, "Activation pipe lost the entry URL");
        string[] broker = DesktopActivationLauncher.BrokerArguments(@"C:\Private State");
        Require(broker.SequenceEqual(["--ensure-running", @"--state-dir=C:\Private State"]),
            "Unexpected broker process arguments");
        Require(!string.Join(" ", broker).Contains("test-token", StringComparison.Ordinal), "Token entered process arguments");
        var secondary = DesktopActivationLauncher.SecondaryStart(
            Path.Combine(Path.GetTempPath(), "HoshiStream.exe"), @"C:\Private State");
        Require(secondary.ArgumentList.SequenceEqual([@"--state-dir=C:\Private State", "--activate-stdin"]),
            "Unexpected activation forwarder arguments");
        Require(secondary.RedirectStandardInput && secondary.RedirectStandardOutput && secondary.RedirectStandardError
            && !secondary.UseShellExecute, "Activation forwarder must use redirected binary streams");
        bool rejected = false;
        try
        {
            DesktopActivationLauncher.Payload(new(1, "shutdown", url));
        }
        catch (InvalidDataException) { rejected = true; }
        Require(rejected, "Unsupported activation accepted");
    }

    private static async Task BrowserEofStopsChild()
    {
        string executable = Environment.ProcessPath ?? throw new InvalidOperationException("No process path");
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
        start.ArgumentList.Add("--self-test-idle-child");
        using Process child = Process.Start(start) ?? throw new InvalidOperationException("Fixture did not start");
        using var input = new DeferredEofStream();
        using var output = new MemoryStream();
        using var diagnostics = new DiagnosticWriter();
        TextWriter original = Console.Error;
        Console.SetError(diagnostics);
        try
        {
            Task<int> relay = Program.RelayChild(child, input, output);
            await diagnostics.Written.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Require(!child.HasExited && !relay.IsCompleted, "Child ended before browser EOF");
            input.End();
            Require(await relay.WaitAsync(TimeSpan.FromSeconds(5)) == 0 && child.HasExited,
                "Browser EOF left child running");
            Require(output.Length == 0, "Diagnostics polluted native stdout");
            Require(!diagnostics.ToString().Contains("private-test-child-diagnostic", StringComparison.Ordinal),
                "Raw child diagnostics escaped");
        }
        finally
        {
            Console.SetError(original);
            input.End();
            if (!child.HasExited)
            {
                child.Kill();
                await child.WaitForExitAsync();
            }
        }
    }

    private sealed class DiagnosticWriter : StringWriter
    {
        internal TaskCompletionSource Written { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override void WriteLine(string? value)
        {
            base.WriteLine(value);
            Written.TrySetResult();
        }
    }

    private sealed class DeferredEofStream : MemoryStream
    {
        private readonly TaskCompletionSource end = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal void End() => end.TrySetResult();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await end.Task.WaitAsync(cancellationToken);
            return 0;
        }
    }

    private sealed class SplitStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            base.ReadAsync(buffer[..Math.Min(buffer.Length, 3)], cancellationToken);
    }
}
