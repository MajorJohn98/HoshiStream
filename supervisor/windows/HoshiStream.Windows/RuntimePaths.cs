using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HoshiStream.Windows;

internal sealed record RuntimePaths(string Root, string State, string Identity)
{
    public string Node => File.Exists(Path.Combine(Root, "bin", "node.exe"))
        ? Path.Combine(Root, "bin", "node.exe") : Path.Combine(Root, "vendor", "node", "win32-x64", "node.exe");
    public string Launcher => Path.Combine(Root, "scripts", "native-server.mjs");
    public string Logs => Path.Combine(State, "logs");
    public string PickerName => $"hoshistream-picker-{Identity}";
    public string PickerPath => $@"\\.\pipe\{PickerName}";
    public string ActivationName => $"hoshistream-activation-{Identity}";
    public string Executable => Environment.ProcessPath ?? throw new InvalidOperationException("No executable path.");

    public static string DefaultState => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HoshiStream");

    public static RuntimePaths Create(string? runtimeRoot, string? stateDirectory = null)
    {
        var root = Path.GetFullPath(runtimeRoot ?? AppContext.BaseDirectory);
        var state = stateDirectory ?? Environment.GetEnvironmentVariable("HOSHISTREAM_STATE_DIR");
        if (string.IsNullOrWhiteSpace(state))
            state = DefaultState;
        if (!Path.IsPathFullyQualified(state))
            throw new ArgumentException("Absolute state directory required.");
        state = Path.TrimEndingDirectorySeparator(Path.GetFullPath(state));
        if (string.Equals(state, Path.GetPathRoot(state), StringComparison.OrdinalIgnoreCase)
            || state.StartsWith(@"\\", StringComparison.Ordinal) && !state.StartsWith(@"\\?\", StringComparison.Ordinal)
            || state.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("State must be a local directory, not a drive root or network share.");
        var sid = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("No user identity.");
        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{sid.Value}\n{state.ToUpperInvariant()}")))[..32].ToLowerInvariant();
        return new(root, state, identity);
    }

    public void PrepareState()
    {
        var directory = Directory.CreateDirectory(State);
        var sid = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("No user identity.");
        var acl = new DirectorySecurity();
        acl.SetOwner(sid);
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(acl);
        Directory.CreateDirectory(Logs);
    }
}

internal sealed class SafeLog : IDisposable
{
    private readonly StreamWriter writer;
    private readonly object gate = new();
    private bool disposed, failed;
    public event EventHandler? Failed;
    public SafeLog(RuntimePaths paths)
    {
        var path = Path.Combine(paths.Logs, "supervisor.log");
        if (File.Exists(path) && new FileInfo(path).Length > 2 * 1024 * 1024)
            File.Move(path, Path.Combine(paths.Logs, "supervisor.previous.log"), true);
        writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
        { AutoFlush = true };
    }

    // Only fixed event identifiers and numeric error codes cross this boundary.
    public void Event(string name, int? code = null)
    {
        lock (gate)
        {
            if (disposed || failed) return;
            try
            {
                writer.WriteLine(JsonSerializer.Serialize(new { time = DateTimeOffset.UtcNow, level = code is null ? "info" : "error", @event = name, code }));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                failed = true;
                Failed?.Invoke(this, EventArgs.Empty);
            }
        }
    }
    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            try { writer.Dispose(); }
            catch (IOException) when (failed) { }
        }
    }
}
