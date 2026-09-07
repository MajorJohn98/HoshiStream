using System.IO.Pipes;
using System.Text.Json;

namespace HoshiStream.Windows;

internal sealed class LocalPipeServer : IDisposable
{
    private readonly CancellationTokenSource lifetime = new();
    private readonly Task[] workers;
    private bool disposed;
    public LocalPipeServer(string name, Action<string> log, Func<NamedPipeServerStream, CancellationToken, Task> handle)
    {
        var pipes = new List<NamedPipeServerStream>();
        try
        {
            for (var i = 0; i < 4; i++) pipes.Add(Create(name));
            workers = pipes.Select(pipe => RunAsync(pipe, name, log, handle)).ToArray();
        }
        catch
        {
            foreach (var pipe in pipes) pipe.Dispose();
            lifetime.Dispose();
            throw;
        }
    }

    private static NamedPipeServerStream Create(string name) => new(name, PipeDirection.InOut, 4,
        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 8192, 8192);

    private async Task RunAsync(NamedPipeServerStream first, string name, Action<string> log,
        Func<NamedPipeServerStream, CancellationToken, Task> handle)
    {
        var pipe = first;
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                using (pipe)
                {
                    try
                    {
                        await pipe.WaitForConnectionAsync(lifetime.Token);
                        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                        timeout.CancelAfter(TimeSpan.FromMinutes(2));
                        await handle(pipe, timeout.Token);
                    }
                    catch (OperationCanceledException) { }
                    catch (Exception error) when (error is IOException or InvalidDataException or JsonException
                        or ArgumentException or InvalidOperationException or FormatException)
                    { if (!lifetime.IsCancellationRequested) log("native_pipe_request_rejected"); }
                }
                if (lifetime.IsCancellationRequested) break;
                pipe = Create(name);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { if (!lifetime.IsCancellationRequested) log("native_pipe_stopped"); }
        finally { pipe.Dispose(); }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        lifetime.Cancel();
        // In-flight UI callbacks must unwind on the UI thread, so don't block it.
        _ = Task.WhenAll(workers).ContinueWith(_ => lifetime.Dispose(), TaskScheduler.Default);
    }
}
