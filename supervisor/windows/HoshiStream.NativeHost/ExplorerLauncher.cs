using System.Runtime.InteropServices;
using System.Text;

namespace HoshiStream.NativeHost;

internal static class ExplorerLauncher
{
    internal static void Open(string executable, string[] arguments, string directory)
    {
        // Obtain Shell.Application from the *existing desktop view*, not a newly
        // created Shell.Application in this Chrome job. Explorer owns the launch.
        // https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643
        object windows = Activator.CreateInstance(Type.GetTypeFromCLSID(
            new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39"), true)!)!;
        object? desktop = null;
        IShellBrowser? browser = null;
        IShellView? view = null;
        object? folder = null;
        object? application = null;
        try
        {
            dynamic shellWindows = windows;
            object location = 0; // CSIDL_DESKTOP
            object? root = null;
            int handle;
            desktop = shellWindows.FindWindowSW(ref location, ref root, 8, out handle, 1);
            var provider = (IServiceProvider)desktop;
            Guid service = new("4C96BE40-915C-11CF-99D3-00AA004AE837");
            Guid browserId = typeof(IShellBrowser).GUID;
            provider.QueryService(ref service, ref browserId, out browser);
            browser.QueryActiveShellView(out view);
            Guid dispatch = new("00020400-0000-0000-C000-000000000046");
            view.GetItemObject(0, ref dispatch, out folder); // SVGIO_BACKGROUND
            application = ((dynamic)folder).Application;
            ((dynamic)application).ShellExecute(executable, string.Join(" ", arguments.Select(QuoteArgument)), directory, "open", 1);
        }
        finally
        {
            foreach (object? item in new object?[] { application, folder, view, browser, desktop, windows })
                if (item is not null && Marshal.IsComObject(item)) Marshal.ReleaseComObject(item);
        }
    }

    // Windows CommandLineToArgvW quoting, not cmd.exe quoting. Even an explicit
    // local-drive root must preserve its trailing backslash inside quotes.
    internal static string QuoteArgument(string argument)
    {
        if (argument.Contains('"') || argument.Any(char.IsControl))
            throw new InvalidDataException("Invalid shell argument");
        var result = new StringBuilder("\"");
        result.Append(argument);
        int trailing = argument.Length - argument.TrimEnd('\\').Length;
        result.Append('\\', trailing);
        result.Append('"');
        return result.ToString();
    }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IServiceProvider
    {
        void QueryService(ref Guid service, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellBrowser browser);
    }

    // Unused slots preserve the COM vtable layout, including IOleWindow's slots.
    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellBrowser
    {
        void GetWindow();
        void ContextSensitiveHelp();
        void InsertMenusSB();
        void SetMenuSB();
        void RemoveMenusSB();
        void SetStatusTextSB();
        void EnableModelessSB();
        void TranslateAcceleratorSB();
        void BrowseObject();
        void GetViewStateStream();
        void GetControlWindow();
        void SendControlMsg();
        void QueryActiveShellView([MarshalAs(UnmanagedType.Interface)] out IShellView view);
    }

    [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellView
    {
        void GetWindow();
        void ContextSensitiveHelp();
        void TranslateAccelerator();
        void EnableModeless();
        void UIActivate();
        void Refresh();
        void CreateViewWindow();
        void DestroyViewWindow();
        void GetCurrentInfo();
        void AddPropertySheetPages();
        void SaveViewState();
        void SelectItem();
        void GetItemObject(uint item, ref Guid iid, [MarshalAs(UnmanagedType.IDispatch)] out object result);
    }
}
