using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace HoshiStream.Windows;

internal sealed class IntegrationConflictException() : InvalidOperationException("Another installation owns the integration.");

internal sealed class NativeIntegrations(RuntimePaths paths)
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Capabilities = @"Software\HoshiStream\Capabilities";
    private const string Applications = @"Software\RegisteredApplications";
    private const string ProgId = "HoshiStream.Magnet";
    private const string ClassKey = @"Software\Classes\" + ProgId;
    private const string OwnerValue = "HoshiStreamInstallPath";

    public string LoginCommand => WindowsCommandLine.QuoteArgument(paths.Executable)
        + (Path.TrimEndingDirectorySeparator(paths.Root).Equals(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory),
            StringComparison.OrdinalIgnoreCase) ? "" : " " + WindowsCommandLine.QuoteArgument("--runtime-root=" + paths.Root))
        + (paths.State.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(RuntimePaths.DefaultState)),
            StringComparison.OrdinalIgnoreCase) ? "" : " " + WindowsCommandLine.QuoteArgument("--state-dir=" + paths.State));

    public void RegisterMagnet()
    {
        using (var existingClass = Registry.CurrentUser.OpenSubKey(ClassKey))
        using (var existingCapabilities = Registry.CurrentUser.OpenSubKey(Capabilities))
        using (var applications = Registry.CurrentUser.OpenSubKey(Applications))
        {
            if (existingClass is not null && !OwnedClass(existingClass)
                || existingCapabilities is not null && !OwnedMarker(existingCapabilities)
                || applications?.GetValue("HoshiStream") is string registered
                    && !registered.Equals(Capabilities, StringComparison.OrdinalIgnoreCase))
                throw new IntegrationConflictException();
        }

        using (var progId = Registry.CurrentUser.CreateSubKey(ClassKey, true))
        {
            progId.SetValue(OwnerValue, paths.Executable, RegistryValueKind.String);
            progId.SetValue("", "HoshiStream magnet link", RegistryValueKind.String);
            progId.SetValue("URL Protocol", "", RegistryValueKind.String);
            using var icon = progId.CreateSubKey("DefaultIcon", true);
            icon.SetValue("", WindowsCommandLine.QuoteArgument(paths.Executable) + ",0", RegistryValueKind.String);
            using var command = progId.CreateSubKey(@"shell\open\command", true);
            command.SetValue("", LoginCommand + " " + WindowsCommandLine.QuoteArgument("--magnet=%1"), RegistryValueKind.String);
        }
        using (var capabilities = Registry.CurrentUser.CreateSubKey(Capabilities, true))
        {
            capabilities.SetValue(OwnerValue, paths.Executable, RegistryValueKind.String);
            capabilities.SetValue("ApplicationName", "HoshiStream", RegistryValueKind.String);
            capabilities.SetValue("ApplicationDescription", "Review magnet links in your private HoshiStream library.", RegistryValueKind.String);
            capabilities.SetValue("ApplicationIcon", WindowsCommandLine.QuoteArgument(paths.Executable) + ",0", RegistryValueKind.String);
            using var associations = capabilities.CreateSubKey("URLAssociations", true);
            associations.SetValue("magnet", ProgId, RegistryValueKind.String);
        }
        using var registeredApplications = Registry.CurrentUser.CreateSubKey(Applications, true);
        registeredApplications.SetValue("HoshiStream", Capabilities, RegistryValueKind.String);
        // Advertise a choice; only Windows Default Apps may make it the default.
        NativeMethods.SHChangeNotify(0x08000000, 0, 0, 0);
    }

    public void Unregister()
    {
        using (var run = Registry.CurrentUser.OpenSubKey(RunKey, true))
        {
            if (run?.GetValue("HoshiStream") is string command
                && (OwnedCommand(command, false) || command.Equals(
                    "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "
                    + WindowsCommandLine.QuoteArgument(Path.Combine(paths.Root, "scripts", "start-native.ps1")),
                    StringComparison.OrdinalIgnoreCase)))
                run.DeleteValue("HoshiStream", false);
        }

        bool ownedCapabilities;
        using (var capabilities = Registry.CurrentUser.OpenSubKey(Capabilities))
            ownedCapabilities = capabilities is not null && OwnedMarker(capabilities);
        if (ownedCapabilities)
        {
            using var applications = Registry.CurrentUser.OpenSubKey(Applications, true);
            if (applications?.GetValue("HoshiStream") is string registered
                && registered.Equals(Capabilities, StringComparison.OrdinalIgnoreCase))
                applications.DeleteValue("HoshiStream", false);
            Registry.CurrentUser.DeleteSubKeyTree(Capabilities, false);
        }
        bool ownedClass;
        using (var progId = Registry.CurrentUser.OpenSubKey(ClassKey))
            ownedClass = progId is not null && OwnedClass(progId);
        if (ownedClass) Registry.CurrentUser.DeleteSubKeyTree(ClassKey, false);
        NativeMethods.SHChangeNotify(0x08000000, 0, 0, 0);
    }

    private bool OwnedMarker(RegistryKey key) => key.GetValue(OwnerValue) is string owner
        && owner.Equals(paths.Executable, StringComparison.OrdinalIgnoreCase);

    private bool OwnedClass(RegistryKey key)
    {
        using var command = key.OpenSubKey(@"shell\open\command");
        return OwnedMarker(key) && (command?.GetValue("") is not string value || OwnedCommand(value, true));
    }

    private bool OwnedCommand(string command, bool magnet)
    {
        if (command.Length is 0 or > 8192) return false;
        var buffer = NativeMethods.CommandLineToArgv(command, out var count);
        if (buffer == 0) throw new Win32Exception();
        try
        {
            if (count is < 1 or > 8) return false;
            var arguments = new string[count];
            for (var index = 0; index < count; index++)
                arguments[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, index * nint.Size)) ?? "";
            return IntegrationCommands.IsOwned(arguments, paths.Executable, magnet);
        }
        finally { NativeMethods.LocalFree(buffer); }
    }
}
