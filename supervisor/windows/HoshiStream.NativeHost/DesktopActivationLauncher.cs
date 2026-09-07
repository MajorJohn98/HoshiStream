using System.Diagnostics;
using System.Text.Json;

namespace HoshiStream.NativeHost;

internal sealed record DesktopActivation(int Version, string Command, string? Value = null);

internal static class DesktopActivationLauncher
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static string[] BrokerArguments(string state) =>
        ["--ensure-running", "--state-dir=" + state];

    internal static ProcessStartInfo SecondaryStart(string executable, string state)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("--state-dir=" + state);
        start.ArgumentList.Add("--activate-stdin");
        return start;
    }

    internal static byte[] Payload(DesktopActivation activation)
    {
        if (activation.Version != 1 ||
            (activation.Command == "open-library" ? activation.Value is not null :
             activation.Command != "open-url" || activation.Value is null || !Program.ValidEntryUrl(activation.Value)))
            throw new InvalidDataException("Invalid desktop activation");
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(activation, Json);
        if (bytes.Length > 65_536) throw new InvalidDataException("Desktop activation exceeds its bound");
        return bytes;
    }

    internal static async Task ForwardAsync(string executable, string state, DesktopActivation activation)
    {
        byte[] payload = Payload(activation);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (true)
        {
            deadline.Token.ThrowIfCancellationRequested();
            // --activate-stdin is strictly forward-only in the tray executable:
            // this short-lived descendant can never become the primary tray.
            using Process child = Process.Start(SecondaryStart(executable, state)) ??
                throw new InvalidOperationException("The activation forwarder did not start");
            Task<bool> output = DrainAsync(child.StandardOutput.BaseStream);
            Task<bool> errors = DrainAsync(child.StandardError.BaseStream);
            try
            {
                await child.StandardInput.BaseStream.WriteAsync(payload, deadline.Token);
                await child.StandardInput.BaseStream.WriteAsync(new byte[] { 10 }, deadline.Token);
                await child.StandardInput.BaseStream.FlushAsync(deadline.Token);
                child.StandardInput.Close();
                await child.WaitForExitAsync(deadline.Token);
            }
            finally
            {
                if (!child.HasExited)
                {
                    try { child.Kill(); }
                    catch (InvalidOperationException) when (child.HasExited) { }
                }
                await child.WaitForExitAsync();
                bool[] diagnostics = await Task.WhenAll(output, errors);
                if (diagnostics.Any(value => value))
                    Console.Error.WriteLine("{\"level\":\"error\",\"event\":\"browser_native_activation_diagnostic\"}");
            }
            if (child.ExitCode == 0) return;
            if (child.ExitCode != 2)
                throw new InvalidOperationException("The desktop activation forwarder failed");
            // Explorer may not have acquired the primary mutex yet. Retrying an
            // unavailable forwarder is bounded and never falls back to URL args.
            await Task.Delay(100, deadline.Token);
        }
    }

    private static async Task<bool> DrainAsync(Stream stream)
    {
        byte[] buffer = new byte[4096];
        bool received = false;
        while (await stream.ReadAsync(buffer) != 0) received = true;
        return received;
    }
}
