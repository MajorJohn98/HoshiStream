using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace HoshiStream.Windows;

internal sealed class OwnedRuntime : IDisposable
{
    private readonly SafeFileHandle job;
    private readonly Process process;
    private readonly StreamWriter input;
    private readonly FileStream output;
    private readonly Task drain;
    private readonly ResourceCollector resources;
    private volatile bool disposed;
    private volatile string? startupFailure;
    public string? StartupFailure => startupFailure;
    public int Id => process.Id;
    public bool HasExited => process.HasExited;
    public int ExitCode => process.ExitCode;
    public Task WaitForExitAsync() => process.WaitForExitAsync();

    private OwnedRuntime(SafeFileHandle job, Process process, SafeFileHandle input, SafeFileHandle output, SafeLog log)
    {
        this.job = job;
        this.process = process;
        resources = new(job, process.Id, log);
        this.input = new StreamWriter(new FileStream(input, FileAccess.Write), new UTF8Encoding(false)) { AutoFlush = true };
        this.output = new FileStream(output, FileAccess.Read);
        // Never persist arbitrary child output: even third-party diagnostics may
        // contain magnet URLs. Preserve only a fixed allowlist of event names.
        drain = Task.Run(() =>
        {
            using var reader = new StreamReader(this.output, Encoding.UTF8, true, 4096, leaveOpen: true);
            var buffer = new char[4096];
            var line = new StringBuilder();
            var oversized = false;
            try
            {
                int count;
                while ((count = reader.Read(buffer, 0, buffer.Length)) != 0)
                {
                    for (var i = 0; i < count; i++)
                    {
                        if (buffer[i] == '\n')
                        {
                            if (!oversized && RuntimeDiagnostics.Classify(line.ToString()) is { } name)
                            {
                                if (name is "runtime_state_already_owned" or "runtime_port_in_use")
                                    startupFailure = name;
                                log.Event(name);
                            }
                            line.Clear();
                            oversized = false;
                        }
                        else if (line.Length < 8192) line.Append(buffer[i]);
                        else oversized = true;
                    }
                }
            }
            catch (IOException) when (disposed) { }
            catch (ObjectDisposedException) when (disposed) { }
        });
    }

    public static OwnedRuntime Start(RuntimePaths paths, string? pickerPath, SafeLog log)
    {
        if (!File.Exists(paths.Node) || !File.Exists(paths.Launcher))
            throw new FileNotFoundException("The bundled runtime is incomplete.");
        var start = new ProcessStartInfo(paths.Node) { WorkingDirectory = paths.Root, UseShellExecute = false };
        start.ArgumentList.Add(paths.Launcher);
        start.ArgumentList.Add($"--state-dir={paths.State}");
        start.ArgumentList.Add($"--project-root={paths.State}");
        start.ArgumentList.Add("--parent-control");
        if (File.Exists(Path.Combine(paths.Root, "native-host", "HoshiStream.NativeHost.exe")))
            start.ArgumentList.Add("--register-browser-bridge");
        start.Environment["HOSHISTREAM_STATE_DIR"] = paths.State;
        if (pickerPath is not null) start.Environment["NATIVE_PICKER_SOCKET"] = pickerPath;
        else start.Environment.Remove("NATIVE_PICKER_SOCKET");
        return StartSuspended(start, log);
    }

    private static OwnedRuntime StartSuspended(ProcessStartInfo start, SafeLog log)
    {
        var job = NativeMethods.CreateJobObject(0, null);
        SafeFileHandle? parentInput = null, parentOutput = null;
        Process? managed = null;
        NativeMethods.ProcessInformation child = default;
        nint attributes = 0, handles = 0, environment = 0;
        var attributesInitialized = false;
        var success = false;
        try
        {
            if (job.IsInvalid) throw new Win32Exception();
            var limits = new NativeMethods.ExtendedLimit { Basic = new NativeMethods.BasicLimit { Flags = 0x2000 } };
            Check(NativeMethods.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<NativeMethods.ExtendedLimit>()));
            var security = new NativeMethods.SecurityAttributes
            { Length = Marshal.SizeOf<NativeMethods.SecurityAttributes>(), Inherit = true };
            Check(NativeMethods.CreatePipe(out var childInput, out parentInput, ref security, 0));
            using (childInput)
            {
                Check(NativeMethods.CreatePipe(out parentOutput, out var childOutput, ref security, 0));
                using (childOutput)
                {
                    Check(NativeMethods.SetHandleInformation(parentInput, 1, 0));
                    Check(NativeMethods.SetHandleInformation(parentOutput, 1, 0));
                    nuint size = 0;
                    NativeMethods.InitializeProcThreadAttributeList(0, 1, 0, ref size);
                    attributes = Marshal.AllocHGlobal(checked((int)size));
                    Check(NativeMethods.InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
                    attributesInitialized = true;
                    handles = Marshal.AllocHGlobal(2 * nint.Size);
                    Marshal.WriteIntPtr(handles, childInput.DangerousGetHandle());
                    Marshal.WriteIntPtr(handles, nint.Size, childOutput.DangerousGetHandle());
                    Check(NativeMethods.UpdateProcThreadAttribute(attributes, 0, 0x20002, handles, (nuint)(2 * nint.Size), 0, 0));
                    var startup = new NativeMethods.StartupInfoEx
                    {
                        Startup = new NativeMethods.StartupInfo
                        {
                            Size = Marshal.SizeOf<NativeMethods.StartupInfoEx>(),
                            Flags = 0x100,
                            Input = childInput.DangerousGetHandle(),
                            Output = childOutput.DangerousGetHandle(),
                            Error = childOutput.DangerousGetHandle()
                        },
                        Attributes = attributes
                    };
                    var block = string.Join('\0', start.Environment.Where(pair => pair.Value is not null)
                        .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                        .Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0";
                    environment = Marshal.StringToHGlobalUni(block);
                    var command = new StringBuilder(string.Join(' ',
                        new[] { start.FileName }.Concat(start.ArgumentList).Select(WindowsCommandLine.QuoteArgument)));
                    Check(NativeMethods.CreateProcess(start.FileName, command, 0, 0, true,
                        0x00000004 | 0x00000400 | 0x00080000 | 0x08000000,
                        environment, start.WorkingDirectory, ref startup, out child));
                    // No user code can execute until ownership is established. In
                    // particular, Node cannot spawn TorrServer before job assignment.
                    Check(NativeMethods.AssignProcessToJobObject(job, child.Process));
                    managed = Process.GetProcessById(checked((int)child.ProcessId));
                    if (NativeMethods.ResumeThread(child.Thread) == uint.MaxValue) throw new Win32Exception();
                    var result = new OwnedRuntime(job, managed, parentInput, parentOutput, log);
                    success = true;
                    return result;
                }
            }
        }
        finally
        {
            if (!success)
            {
                if (child.Process != 0) NativeMethods.TerminateProcess(child.Process, 1);
                job.Dispose();
                managed?.Dispose();
                parentInput?.Dispose();
                parentOutput?.Dispose();
            }
            if (child.Thread != 0) NativeMethods.CloseHandle(child.Thread);
            if (child.Process != 0) NativeMethods.CloseHandle(child.Process);
            if (attributesInitialized) NativeMethods.DeleteProcThreadAttributeList(attributes);
            if (attributes != 0) Marshal.FreeHGlobal(attributes);
            if (handles != 0) Marshal.FreeHGlobal(handles);
            if (environment != 0) Marshal.FreeHGlobal(environment);
        }
    }

    public Task<ResourceReport> CollectResourcesAsync(int pid, CancellationToken cancellation) =>
        disposed ? Task.FromResult(new ResourceReport(false)) : resources.CollectAsync(pid, cancellation);

    private static void Check(bool success) { if (!success) throw new Win32Exception(); }

    public async Task StopAsync(SafeLog log)
    {
        if (disposed) return;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
            if (!process.HasExited)
            {
                try { await input.WriteLineAsync("{\"version\":1,\"command\":\"shutdown\"}".AsMemory(), timeout.Token); }
                catch (IOException) { log.Event("runtime_control_disconnected"); }
                input.Dispose();
                await process.WaitForExitAsync(timeout.Token);
            }
        }
        catch (OperationCanceledException) { log.Event("runtime_forced_stop"); }
        finally { Dispose(); }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        job.Dispose();
        input.Dispose();
        // Closing the job kills every remaining writer, completing the blocking
        // drain before closing its read handle.
        if (drain.Wait(TimeSpan.FromSeconds(2))) output.Dispose();
        else _ = drain.ContinueWith(_ => output.Dispose(), TaskScheduler.Default);
        process.Dispose();
    }
}
