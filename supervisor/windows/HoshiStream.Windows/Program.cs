using System.ComponentModel;
using System.Security;
using System.Text.Json;

namespace HoshiStream.Windows;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            if (args.SequenceEqual(["--self-test"]))
                return SelfTests.Run();

            var options = LaunchOptions.Parse(args);
            var requested = options.Activation;
            if (options.ActivateFromStdin)
            {
                using var input = Console.OpenStandardInput();
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                requested = Contracts.ReadStdinActivationAsync(input, deadline.Token)
                    .WaitAsync(deadline.Token).GetAwaiter().GetResult();
            }
            var paths = RuntimePaths.Create(options.RuntimeRoot, options.StateDirectory);
            if (requested.Command is "register-magnet" or "unregister-integrations")
            {
                var integrations = new NativeIntegrations(paths);
                if (requested.Command == "register-magnet") integrations.RegisterMagnet();
                else integrations.Unregister();
                return 0;
            }
            using var mutex = new Mutex(false, $@"Global\HoshiStream-{paths.Identity}");
            bool ownsMutex;
            try { ownsMutex = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { ownsMutex = true; }
            if (!ownsMutex)
            {
                if (ActivationServer.ForwardAsync(paths, requested).GetAwaiter().GetResult()) return 0;
                if (!options.ActivateFromStdin && requested.Command != "shutdown")
                    MessageBox.Show("Another HoshiStream instance is starting, stopping, or belongs to a different installation. "
                        + "Wait a moment and try again, or quit it from its tray menu.",
                        "HoshiStream", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 2;
            }
            try
            {
                // Browser helpers broker a separate primary via Explorer first.
                // A redirected-stdin helper must never become the long-lived tray.
                if (options.ActivateFromStdin)
                    return 2;
                if (requested.Command == "shutdown")
                    return 0;
                paths.PrepareState();
                using var log = new SafeLog(paths);
                using var app = new TrayApplication(paths, log, requested);
                Application.Run(app);
                return 0;
            }
            finally { mutex.ReleaseMutex(); }
        }
        catch (Exception error) when (error is ArgumentException or IOException or InvalidDataException or UnauthorizedAccessException
            or Win32Exception or InvalidOperationException or SecurityException or JsonException or OperationCanceledException)
        {
            // Exceptions may contain command arguments, paths or credentials.
            if (!args.Any(argument => argument is "--shutdown" or "--activate-stdin" or "--register-magnet" or "--unregister-integrations"))
                MessageBox.Show("HoshiStream could not start. Check that its installation is complete and that "
                    + "your HoshiStream state folder is writable. Close another HoshiStream instance before trying again.",
                    "HoshiStream", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
