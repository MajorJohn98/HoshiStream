using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace HoshiStream.Windows;

internal sealed class ResourceCollector(SafeFileHandle job, int ownerPid, SafeLog log)
{
    private const int MaximumProcesses = 256;
    private int sampling;

    public async Task<ResourceReport> CollectAsync(int pid, CancellationToken cancellation)
    {
        if (pid != ownerPid)
        {
            log.Event("native_resources_wrong_owner");
            return new(false);
        }
        if (Interlocked.CompareExchange(ref sampling, 1, 0) != 0) return new(false);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromMilliseconds(1300));
        var token = deadline.Token;
        // Native queries stay off the STA thread. The busy flag remains held
        // until a timed-out native snapshot actually unwinds.
        var sample = Task.Run(async () =>
        {
            try
            {
                var first = Capture(token);
                await Task.Delay(180, token);
                var second = Capture(token);
                var result = ResourceSamples.Measure(first, second, ownerPid);
                if (!result.Available) log.Event("native_resources_sample_changed");
                return result;
            }
            catch (Exception error) when (error is Win32Exception or InvalidDataException
                or ObjectDisposedException or OverflowException or OperationCanceledException)
            {
                log.Event("native_resources_unavailable");
                return new ResourceReport(false);
            }
            finally { Interlocked.Exchange(ref sampling, 0); }
        }, CancellationToken.None);
        try { return await sample.WaitAsync(token); }
        catch (OperationCanceledException)
        {
            log.Event("native_resources_timeout");
            return new(false);
        }
    }

    private Dictionary<int, ProcessSample> Capture(CancellationToken cancellation)
    {
        var result = new Dictionary<int, ProcessSample>();
        var size = checked(8 + MaximumProcesses * nint.Size);
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            cancellation.ThrowIfCancellationRequested();
            Check(NativeMethods.QueryInformationJobObject(job, 3, buffer, (uint)size, out _));
            var assigned = Marshal.ReadInt32(buffer);
            var count = Marshal.ReadInt32(buffer, 4);
            if (assigned < 0 || count < 0 || count > MaximumProcesses || count != assigned)
                throw new InvalidDataException("Incomplete owned process snapshot.");
            for (var index = 0; index < count; index++)
            {
                cancellation.ThrowIfCancellationRequested();
                var pid = checked((int)Marshal.ReadIntPtr(buffer, 8 + index * nint.Size));
                using var handle = NativeMethods.OpenProcess(0x1000 | 0x0010, false, pid);
                if (handle.IsInvalid)
                {
                    // A process can exit between job enumeration and handle open.
                    if (Marshal.GetLastWin32Error() == 87 && pid != ownerPid) continue;
                    throw new Win32Exception();
                }
                Check(NativeMethods.IsProcessInJob(handle, job, out var belongs));
                if (!belongs) throw new InvalidDataException("Owned process identity changed.");
                Check(NativeMethods.GetExitCodeProcess(handle, out var exitCode));
                if (exitCode != 259) continue;
                var image = new StringBuilder(32_768);
                var characters = image.Capacity;
                Check(NativeMethods.QueryFullProcessImageName(handle, 0, image, ref characters));
                var name = Path.GetFileNameWithoutExtension(image.ToString());
                var group = pid == ownerPid && name.Equals("node", StringComparison.OrdinalIgnoreCase) ? "addon"
                    : name.Equals("TorrServer-windows-amd64", StringComparison.OrdinalIgnoreCase)
                        || name.Equals("TorrServer", StringComparison.OrdinalIgnoreCase) ? "torrServer"
                    : name.Equals("ffmpeg", StringComparison.OrdinalIgnoreCase) ? "ffmpeg" : null;
                if (group is null) continue;
                Check(NativeMethods.GetProcessTimes(handle, out var created, out _, out var kernel, out var user));
                var memory = new NativeMethods.ProcessMemoryCounters { Size = (uint)Marshal.SizeOf<NativeMethods.ProcessMemoryCounters>() };
                Check(NativeMethods.GetProcessMemoryInfo(handle, ref memory, memory.Size));
                result.Add(pid, new(pid, created, group, checked(kernel + user),
                    checked((long)memory.WorkingSet), Stopwatch.GetTimestamp()));
            }
            cancellation.ThrowIfCancellationRequested();
            if (!result.ContainsKey(ownerPid)) throw new InvalidDataException("Owned Node is no longer running.");
            return result;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void Check(bool success) { if (!success) throw new Win32Exception(); }
}
