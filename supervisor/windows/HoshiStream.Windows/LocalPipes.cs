using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Security.Principal;

namespace HoshiStream.Windows;

internal static class PipeIdentity
{
    public static bool SameExecutable(uint pid, string executable)
    {
        try
        {
            using var process = Process.GetProcessById(checked((int)pid));
            var path = process.MainModule?.FileName;
            return path is not null && string.Equals(Path.GetFullPath(path), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or Win32Exception or OverflowException)
        { return false; }
    }
}

internal sealed class ActivationServer : IDisposable
{
    private readonly LocalPipeServer server;
    public ActivationServer(RuntimePaths paths, SafeLog log, Func<Activation, Task<bool>> receive)
    {
        server = new(paths.ActivationName, name => log.Event(name), async (pipe, cancellation) =>
        {
            using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            requestTimeout.CancelAfter(TimeSpan.FromSeconds(5));
            using var document = await PipeMessages.ReadAsync(pipe, 65_536, requestTimeout.Token);
            var message = document.Deserialize<Activation>(Contracts.Json);
            var accepted = message is not null && Contracts.ValidActivation(message);
            if (accepted && message!.Command == "shutdown")
                accepted = NativeMethods.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid)
                    && PipeIdentity.SameExecutable(pid, paths.Executable);
            if (accepted) accepted = await receive(message!);
            await PipeMessages.WriteAsync(pipe, new { version = 1, accepted }, requestTimeout.Token);
        });
    }

    public static async Task<bool> ForwardAsync(RuntimePaths paths, Activation activation)
    {
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            using var pipe = new NamedPipeClientStream(".", paths.ActivationName, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, TokenImpersonationLevel.Identification);
            await pipe.ConnectAsync(deadline.Token);
            if (!NativeMethods.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid)
                || !PipeIdentity.SameExecutable(pid, paths.Executable)) return false;
            await PipeMessages.WriteAsync(pipe,
                activation.Command == "default" ? new Activation(1, "open-library") : activation, deadline.Token);
            using var response = await PipeMessages.ReadAsync(pipe, 4096, deadline.Token);
            var ok = response.RootElement.TryGetProperty("version", out var version) && version.GetInt32() == 1
                && response.RootElement.TryGetProperty("accepted", out var accepted) && accepted.ValueKind == JsonValueKind.True;
            if (ok && activation.Command == "shutdown")
            {
                try
                {
                    using var target = Process.GetProcessById(checked((int)pid));
                    using var stopped = new CancellationTokenSource(TimeSpan.FromSeconds(16));
                    await target.WaitForExitAsync(stopped.Token);
                }
                catch (ArgumentException) { /* The verified instance already exited. */ }
            }
            return ok;
        }
        catch (Exception error) when (error is IOException or InvalidDataException or OperationCanceledException or JsonException
            or UnauthorizedAccessException or InvalidOperationException or FormatException)
        { return false; }
    }
    public void Dispose() => server.Dispose();
}

internal sealed class PickerServer : IDisposable
{
    private readonly LocalPipeServer server;
    private int pending;
    public PickerServer(RuntimePaths paths, SafeLog log,
        Func<int, CancellationToken, Task<ResourceReport>> resources, Func<string, CancellationToken, Task<string?>> pick)
    {
        server = new(paths.PickerName, name => log.Event(name), async (pipe, cancellation) =>
        {
            using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            requestTimeout.CancelAfter(TimeSpan.FromSeconds(5));
            using var document = await PipeMessages.ReadAsync(pipe, 8192, requestTimeout.Token);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("nonce", out var nonceValue) || nonceValue.ValueKind != JsonValueKind.String
                || !Guid.TryParseExact(nonceValue.GetString(), "D", out _)
                || !root.TryGetProperty("kind", out var kindValue) || kindValue.ValueKind != JsonValueKind.String)
                throw new InvalidDataException("Invalid native request.");
            var nonce = nonceValue.GetString();
            var kind = kindValue.GetString();
            if (kind == "ping")
            {
                await PipeMessages.WriteAsync(pipe, new { nonce, available = true }, cancellation);
                return;
            }
            if (kind == "resources")
            {
                if (!root.TryGetProperty("pid", out var pid) || pid.ValueKind != JsonValueKind.Number || !pid.TryGetInt32(out var value) || value <= 0)
                    throw new InvalidDataException("Invalid resource request.");
                var report = await resources(value, cancellation);
                await PipeMessages.WriteAsync(pipe, new { nonce, processes = report }, cancellation);
                return;
            }
            if (kind is not ("file" or "folder")) throw new InvalidDataException("Unknown picker kind.");
            if (Interlocked.CompareExchange(ref pending, 1, 0) != 0)
            {
                log.Event("native_picker_busy");
                await PipeMessages.WriteAsync(pipe, new { nonce, cancelled = true }, cancellation);
                return;
            }
            try
            {
                using var selection = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                selection.CancelAfter(TimeSpan.FromSeconds(90));
                var chosen = pick(kind, selection.Token);
                // A disconnected caller must not leave an orphaned modal dialog.
                var disconnected = pipe.ReadAsync(new byte[1], selection.Token).AsTask();
                if (await Task.WhenAny(chosen, disconnected) == disconnected)
                {
                    selection.Cancel();
                    await chosen;
                    return;
                }
                var path = await chosen;
                await PipeMessages.WriteAsync(pipe, path is null
                    ? new { nonce, cancelled = true } : (object)new { nonce, path }, cancellation);
                selection.Cancel();
                try { await disconnected; }
                catch (OperationCanceledException) { }
            }
            finally { Interlocked.Exchange(ref pending, 0); }
        });
    }
    public void Dispose() => server.Dispose();
}
