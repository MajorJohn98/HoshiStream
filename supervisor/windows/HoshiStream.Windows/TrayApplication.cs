using System.ComponentModel;
using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace HoshiStream.Windows;

internal sealed class TrayApplication : ApplicationContext
{
    private readonly RuntimePaths paths;
    private readonly SafeLog log;
    private readonly TrayOwner owner = new();
    private readonly NotifyIcon tray = new();
    private readonly ContextMenuStrip menu = new() { RenderMode = ToolStripRenderMode.System };
    private readonly ToolStripMenuItem statusItem = new("Starting...") { Enabled = false };
    private readonly ToolStripMenuItem restartItem = new("&Restart Server");
    private readonly ToolStripMenuItem speedItem = new("Check &Speed");
    private readonly ToolStripMenuItem pointerItem = new("&Update Remote Pointer") { Visible = false };
    private readonly ToolStripMenuItem loginItem = new("Start at &Login");
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 2000 };
    private readonly CancellationTokenSource lifetime = new();
    private readonly ManagementClient api;
    private readonly NativeIntegrations integrations;
    private readonly SleepInhibitor sleep;
    private readonly ActivationServer activation;
    private readonly PickerServer picker;
    private readonly Queue<(Activation Action, DateTimeOffset Deadline)> pending = new();
    private readonly Icon icon;
    private OwnedRuntime? runtime;
    private Task runtimeStop = Task.CompletedTask;
    private bool ready, polling, draining, stopping, disposed, attemptedWelcome, receivedActivation;
    private int generation, retries, environmentChanged;
    private DateTimeOffset startedAt, readyAt;

    public TrayApplication(RuntimePaths paths, SafeLog log, Activation initial)
    {
        this.paths = paths;
        this.log = log;
        api = new(paths);
        integrations = new(paths);
        sleep = new(log);
        _ = owner.Handle;
        log.Failed += LogFailed;
        icon = CreateIcon();
        owner.ExplorerRestarted += (_, _) => { tray.Visible = false; tray.Visible = !stopping; };
        owner.SessionEnding += (_, _) => _ = QuitAsync();
        activation = new(paths, log, ReceiveAsync);
        picker = new(paths, log, (pid, cancellation) =>
            runtime?.CollectResourcesAsync(pid, cancellation) ?? Task.FromResult(new ResourceReport(false)), ShowPickerAsync);
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        Add("&Open HoshiStream", () => QueueOpen("open-library"));
        Add("&Get Started", () => QueueOpen("welcome"));
        Add("&Copy Stremio URL", async () =>
        {
            if (!RequireReady()) return;
            SetStatus("Verifying Stremio URL...");
            var url = await api.ManifestUrlAsync(lifetime.Token);
            if (stopping) return;
            Clipboard.SetText(url);
            Notify("Stremio URL copied", "Paste the verified URL into Nuvio or Stremio.");
        });
        restartItem.Click += (_, _) => RunAction(RestartAsync);
        menu.Items.Add(restartItem);
        speedItem.Click += (_, _) => RunAction(CheckSpeedAsync);
        menu.Items.Add(speedItem);
        pointerItem.Click += (_, _) => RunAction(PushPointerAsync);
        menu.Items.Add(pointerItem);
        menu.Items.Add(new ToolStripSeparator());
        loginItem.Click += (_, _) => RunAction(ToggleLoginAsync);
        menu.Items.Add(loginItem);
        Add("Magnet Link &Settings...", () =>
        {
            try { integrations.RegisterMagnet(); }
            catch (IntegrationConflictException)
            {
                Error("A different HoshiStream installation owns magnet registration. Uninstall that installation before registering this one.");
                return Task.CompletedTask;
            }
            OpenExternal("ms-settings:defaultapps");
            Notify("Choose a default magnet app", "In Default apps, search for the MAGNET link type and choose HoshiStream. Your current choice is unchanged until you select it.");
            return Task.CompletedTask;
        });
        Add("Show L&ogs", () => { OpenExternal(paths.Logs); return Task.CompletedTask; });
        menu.Items.Add(new ToolStripSeparator());
        Add("&Quit HoshiStream", QuitAsync);
        menu.Opening += (_, _) => RefreshLogin();
        tray.Icon = icon;
        tray.Text = "HoshiStream - Starting";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += (_, _) => RunAction(() => QueueOpen("open-library"));
        timer.Tick += (_, _) =>
        {
            if (Interlocked.Exchange(ref environmentChanged, 0) != 0)
            {
                sleep.Update(false);
                startedAt = DateTimeOffset.UtcNow;
                log.Event("runtime_environment_changed");
            }
            RunAction(PollAsync);
        };
        NetworkChange.NetworkAddressChanged += NetworkAddressChanged;
        SystemEvents.PowerModeChanged += PowerModeChanged;
        timer.Start();
        owner.BeginInvoke(() =>
        {
            if (initial.Command != "default") Enqueue(initial);
            RunAction(MigrateLoginAsync);
            StartRuntime();
        });
    }

    private void Add(string title, Func<Task> action)
    {
        var item = new ToolStripMenuItem(title);
        item.Click += (_, _) => RunAction(action);
        menu.Items.Add(item);
    }

    private static bool Expected(Exception error) => error is IOException or InvalidDataException or HttpRequestException or JsonException
        or InvalidOperationException or UnauthorizedAccessException or Win32Exception or SecurityException
        or OperationCanceledException or KeyNotFoundException or FormatException or ArgumentException
        or ExternalException;

    private async void RunAction(Func<Task> action)
    {
        try { await action(); }
        catch (OperationCanceledException) when (stopping) { }
        catch (Exception error) when (Expected(error))
        {
            if (!stopping)
            {
                log.Event("tray_action_failed");
                Error("The action could not finish. Check that the server is ready and try again. Show Logs has startup details.");
            }
        }
    }

    private Task<bool> ReceiveAsync(Activation value)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (stopping) return Task.FromResult(false);
        owner.BeginInvoke(() =>
        {
            if (stopping) { completion.TrySetResult(false); return; }
            if (value.Command == "shutdown")
            {
                completion.TrySetResult(true);
                // Let the activation acknowledgement flush before closing IPC.
                RunAction(async () => { await Task.Delay(150); await QuitAsync(); });
            }
            else completion.TrySetResult(Enqueue(value));
        });
        return completion.Task;
    }

    private bool Enqueue(Activation value)
    {
        if (value.Command == "ensure-running" && Contracts.ValidActivation(value))
        {
            receivedActivation = true;
            return true;
        }
        if (!Contracts.ValidActivation(value) || pending.Count >= 16)
        {
            Error("Too many links arrived, or a link was invalid. Wait for Ready and open one link at a time.");
            return false;
        }
        if (pending.Any(item => item.Action == value)) return true;
        receivedActivation = true;
        pending.Enqueue((value, DateTimeOffset.UtcNow.AddSeconds(60)));
        RunAction(DrainAsync);
        return true;
    }

    private Task QueueOpen(string command)
    {
        if (command == "welcome")
        {
            if (!RequireReady()) return Task.CompletedTask;
            OpenExternal(api.ReadCredentials().ManagementUrl + "#/welcome");
        }
        else Enqueue(new Activation(1, command));
        return Task.CompletedTask;
    }

    private async Task DrainAsync()
    {
        if (draining || stopping) return;
        draining = true;
        try
        {
            while (pending.TryPeek(out var next))
            {
                if (next.Deadline <= DateTimeOffset.UtcNow)
                {
                    pending.Dequeue();
                    Error("HoshiStream was not ready in time. Wait for Ready, then open the original link again.");
                    continue;
                }
                if (!ready) break;
                pending.Dequeue();
                var credentials = api.ReadCredentials();
                switch (next.Action.Command)
                {
                    case "open-library":
                    case "default":
                        OpenExternal(credentials.ManagementUrl);
                        break;
                    case "open-welcome":
                        OpenExternal(credentials.ManagementUrl + "#/welcome");
                        break;
                    case "open-url":
                        if (!api.MatchesManagementUrl(next.Action.Value!))
                        {
                            Error("This link does not match this HoshiStream instance. Open HoshiStream from its tray menu.");
                            break;
                        }
                        OpenExternal(next.Action.Value!);
                        break;
                    case "magnet":
                        using (var ticket = await api.ApiAsync("/api/imports/magnet-links", HttpMethod.Post,
                            new { magnetUri = "magnet:" + next.Action.Value![7..] }, TimeSpan.FromSeconds(10), lifetime.Token))
                        {
                            if (!Guid.TryParseExact(ticket.RootElement.GetProperty("id").GetString(), "D", out var id))
                                throw new InvalidDataException("Invalid review ticket.");
                            if (!stopping)
                                OpenExternal(credentials.ManagementUrl + "#/add/magnet/" + id.ToString("D"));
                        }
                        break;
                }
            }
        }
        finally { draining = false; }
    }

    private void StartRuntime()
    {
        if (stopping || runtime is not null || !runtimeStop.IsCompleted) return;
        generation++;
        ready = false;
        startedAt = DateTimeOffset.UtcNow;
        SetStatus(retries == 0 ? "Starting..." : $"Recovering - attempt {retries} of 5...");
        try
        {
            runtime = OwnedRuntime.Start(paths, paths.PickerPath, log);
            log.Event("runtime_started");
            var current = runtime;
            RunAction(async () =>
            {
                await current.WaitForExitAsync();
                if (runtime != current || stopping) return;
                var code = current.ExitCode;
                log.Event("runtime_exited", code);
                await RecoverAsync(current, code);
            });
        }
        catch (Exception error) when (Expected(error))
        {
            log.Event("runtime_start_failed");
            SetStatus("Error - restart or show logs");
            Notify("HoshiStream could not start", "Check the installation and state folder, then choose Restart Server. Show Logs has details.");
        }
    }

    private async Task PollAsync()
    {
        if (polling || stopping) return;
        polling = true;
        var current = runtime;
        try
        {
            if (current is null) { await DrainAsync(); return; }
            ServerSummary? summary;
            try { summary = await api.PollAsync(current.Id, lifetime.Token); }
            catch (Exception error) when (Expected(error)) { summary = null; }
            if (stopping || runtime != current) return;
            sleep.Update(summary?.Streaming == true);
            if (summary is null)
            {
                if (ready) log.Event("runtime_status_lost");
                ready = false;
                SetStatus("Starting or reconnecting...");
                if (DateTimeOffset.UtcNow - startedAt > TimeSpan.FromSeconds(60))
                {
                    log.Event("runtime_readiness_timeout");
                    await RecoverAsync(current);
                }
            }
            else
            {
                if (!ready) readyAt = DateTimeOffset.UtcNow;
                ready = true;
                startedAt = DateTimeOffset.UtcNow;
                if (DateTimeOffset.UtcNow - readyAt > TimeSpan.FromMinutes(5)) retries = 0;
                pointerItem.Visible = summary.PointerConfigured;
                if (pointerItem.Enabled)
                    pointerItem.Text = summary.PointerStale ? "&Update Remote Pointer - IP changed" : "&Update Remote Pointer";
                SetStatus($"Ready - {summary.LibraryCount} titles - {summary.Speed:0.#} Mbps");
                await DrainAsync();
                if (summary.WelcomePending && !attemptedWelcome && !receivedActivation && !stopping)
                {
                    attemptedWelcome = true;
                    using var welcome = await api.ApiAsync("/api/onboarding", HttpMethod.Post,
                        new { action = "welcome-shown" }, cancellation: lifetime.Token);
                    if (!receivedActivation && !stopping) OpenExternal(api.ReadCredentials().ManagementUrl + "#/welcome");
                }
            }
            await DrainAsync();
        }
        finally { polling = false; }
    }

    private async Task RecoverAsync(OwnedRuntime current, int? exitCode = null)
    {
        if (runtime != current || stopping) return;
        var version = generation;
        if (current.HasExited) exitCode = current.ExitCode;
        ready = false;
        sleep.Update(false);
        await StopRuntimeAsync(current);
        if (generation != version || stopping) return;
        if (!RuntimeDiagnostics.ShouldRecover(exitCode, current.StartupFailure))
        {
            if (exitCode == 0)
                SetStatus("Stopped - choose Restart Server");
            else
            {
                var stateOwned = current.StartupFailure == "runtime_state_already_owned";
                SetStatus(stateOwned ? "Stopped - state already in use" : "Stopped - port already in use");
                Notify("HoshiStream could not start", stateOwned
                    ? "A terminal instance already owns this state folder. Stop it with the terminal stop command, then choose Restart Server."
                    : "A configured port is already in use. Stop the conflicting application or change your configuration, then choose Restart Server.");
            }
            return;
        }
        if (retries >= 5)
        {
            SetStatus("Error - restart or show logs");
            Notify("The server could not stay running", "Automatic recovery has stopped. Choose Show Logs, fix the problem, then choose Restart Server.");
            return;
        }
        retries++;
        SetStatus($"Recovering - attempt {retries} of 5...");
        await Task.Delay(TimeSpan.FromSeconds(Math.Min(2 * Math.Pow(2, retries - 1), 30)), lifetime.Token);
        if (generation == version && !stopping) StartRuntime();
    }

    private async Task RestartAsync()
    {
        if (stopping || !restartItem.Enabled) return;
        restartItem.Enabled = false;
        try
        {
            generation++;
            retries = 0;
            ready = false;
            sleep.Update(false);
            SetStatus("Restarting...");
            var current = runtime;
            if (current is not null) await StopRuntimeAsync(current);
            else await runtimeStop;
            StartRuntime();
        }
        finally { restartItem.Enabled = true; }
    }

    private async Task CheckSpeedAsync()
    {
        if (!RequireReady()) return;
        speedItem.Enabled = false;
        speedItem.Text = "Measuring speed...";
        try
        {
            using var result = await api.ApiAsync("/api/speedtest", HttpMethod.Post, timeout: TimeSpan.FromSeconds(30), cancellation: lifetime.Token);
            var speed = result.RootElement.GetProperty("mbps").GetDouble();
            if (!double.IsFinite(speed) || speed < 0) throw new InvalidDataException("Invalid speed.");
            Notify("Speed check complete", $"Measured connection speed: {speed:0.#} Mbps.");
        }
        finally { speedItem.Enabled = true; speedItem.Text = "Check &Speed"; }
    }

    private async Task PushPointerAsync()
    {
        if (!RequireReady()) return;
        pointerItem.Enabled = false;
        pointerItem.Text = "Updating remote pointer...";
        try
        {
            using var result = await api.ApiAsync("/api/pointer/push", HttpMethod.Post, timeout: TimeSpan.FromSeconds(15), cancellation: lifetime.Token);
            Notify("Remote pointer updated", "The remote pointer now uses your current LAN address.");
        }
        finally { pointerItem.Enabled = true; pointerItem.Text = "&Update Remote Pointer"; }
    }

    private string LoginCommand => integrations.LoginCommand;

    private void RefreshLogin()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
            loginItem.Checked = string.Equals(key?.GetValue("HoshiStream") as string, LoginCommand, StringComparison.OrdinalIgnoreCase);
        }
        catch (SecurityException) { loginItem.Enabled = false; log.Event("login_status_unavailable"); }
    }

    private Task ToggleLoginAsync()
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
        var existing = key.GetValue("HoshiStream") as string;
        if (string.Equals(existing, LoginCommand, StringComparison.OrdinalIgnoreCase))
            key.DeleteValue("HoshiStream", false);
        else if (existing is null)
            key.SetValue("HoshiStream", LoginCommand, RegistryValueKind.String);
        else
        {
            Error("A different HoshiStream startup entry already exists. Remove that entry in Windows Startup settings before enabling this installation.");
            return Task.CompletedTask;
        }

        RefreshLogin();
        return Task.CompletedTask;
    }

    private Task MigrateLoginAsync()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
        var legacy = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "
            + WindowsCommandLine.QuoteArgument(Path.Combine(paths.Root, "scripts", "start-native.ps1"));
        if (string.Equals(key?.GetValue("HoshiStream") as string, legacy, StringComparison.OrdinalIgnoreCase))
        {
            key!.SetValue("HoshiStream", LoginCommand, RegistryValueKind.String);
            log.Event("owned_login_entry_migrated");
        }
        return Task.CompletedTask;
    }
    private Task<string?> ShowPickerAsync(string kind, CancellationToken cancellation)
    {
        var result = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.BeginInvoke(() =>
        {
            if (stopping || cancellation.IsCancellationRequested) { result.TrySetResult(null); return; }
            var threadId = NativeMethods.GetCurrentThreadId();
            void CloseDialog() =>
                NativeMethods.EnumThreadWindows(threadId, (window, _) =>
                {
                    var name = new StringBuilder(256);
                    GetClassName(window, name, name.Capacity);
                    if (name.ToString() == "#32770") NativeMethods.PostMessage(window, 0x0010, 0, 0);
                    return true;
                }, 0);
            using var registration = cancellation.Register(CloseDialog);
            // Cancellation can arrive between registration and creation of the
            // native dialog HWND. The modal loop also dispatches this timer.
            using var cancellationTimer = new System.Windows.Forms.Timer { Interval = 100 };
            cancellationTimer.Tick += (_, _) => { if (cancellation.IsCancellationRequested) CloseDialog(); };
            cancellationTimer.Start();
            try
            {
                if (cancellation.IsCancellationRequested) { result.TrySetResult(null); return; }
                string? path = null;
                if (kind == "file")
                {
                    using var dialog = new OpenFileDialog
                    {
                        Title = "Choose a video for HoshiStream",
                        Filter = "Video files (*.mp4;*.mkv;*.webm;*.avi;*.mov;*.m4v)|*.mp4;*.mkv;*.webm;*.avi;*.mov;*.m4v",
                        CheckFileExists = true,
                        Multiselect = false,
                        RestoreDirectory = true,
                        AddToRecent = false
                    };
                    if (dialog.ShowDialog(owner) == DialogResult.OK) path = dialog.FileName;
                }
                else
                {
                    using var dialog = new FolderBrowserDialog
                    {
                        Description = "Choose a folder for HoshiStream",
                        UseDescriptionForTitle = true,
                        ShowNewFolderButton = true,
                        AddToRecent = false
                    };
                    if (dialog.ShowDialog(owner) == DialogResult.OK) path = dialog.SelectedPath;
                }
                result.TrySetResult(cancellation.IsCancellationRequested ? null : path);
            }
            catch (Exception error) when (Expected(error))
            {
                log.Event("native_picker_failed");
                result.TrySetResult(null);
                Error("The selection dialog could not open. Try again or use the manual file option.");
            }
        });
        return result.Task;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint window, StringBuilder name, int maximum);

    private bool RequireReady()
    {
        if (ready) return true;
        Error("The server is not ready yet. Wait for Ready or choose Restart Server.");
        return false;
    }
    private void OpenExternal(string value) => Process.Start(new ProcessStartInfo(value) { UseShellExecute = true })?.Dispose();
    private void SetStatus(string text)
    {
        statusItem.Text = text;
        var tooltip = "HoshiStream - " + text;
        tray.Text = tooltip.Length <= 63 ? tooltip : tooltip[..63];
    }
    private void Notify(string title, string message) => tray.ShowBalloonTip(5000, title, message, ToolTipIcon.Info);
    private void Error(string message)
    {
        SetStatus("Action failed - try again");
        tray.ShowBalloonTip(6000, "HoshiStream", message, ToolTipIcon.Warning);
    }
    private void LogFailed(object? sender, EventArgs args)
    {
        if (!stopping && !owner.IsDisposed)
            owner.BeginInvoke(() => Error("Startup logs could not be written. Check available disk space and your state folder permissions."));
    }
    private void NetworkAddressChanged(object? sender, EventArgs args) => Interlocked.Exchange(ref environmentChanged, 1);
    private void PowerModeChanged(object sender, PowerModeChangedEventArgs args)
    {
        if (args.Mode == PowerModes.Resume) Interlocked.Exchange(ref environmentChanged, 1);
    }

    private async Task QuitAsync()
    {
        if (stopping) return;
        stopping = true;
        log.Failed -= LogFailed;
        generation++;
        ready = false;
        timer.Stop();
        NetworkChange.NetworkAddressChanged -= NetworkAddressChanged;
        SystemEvents.PowerModeChanged -= PowerModeChanged;
        SetStatus("Stopping...");
        menu.Enabled = false;
        lifetime.Cancel();
        sleep.Update(false);
        picker.Dispose();
        activation.Dispose();
        pending.Clear();
        var current = runtime;
        try
        {
            if (current is not null) await StopRuntimeAsync(current);
            else await runtimeStop;
        }
        finally { ExitThread(); }
    }

    private Task StopRuntimeAsync(OwnedRuntime current)
    {
        runtime = null;
        runtimeStop = current.StopAsync(log);
        return runtimeStop;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            disposed = true;
            stopping = true;
            log.Failed -= LogFailed;
            lifetime.Cancel();
            timer.Dispose();
            NetworkChange.NetworkAddressChanged -= NetworkAddressChanged;
            SystemEvents.PowerModeChanged -= PowerModeChanged;
            picker.Dispose();
            activation.Dispose();
            runtime?.Dispose();
            sleep.Dispose();
            tray.Visible = false;
            tray.Dispose();
            icon.Dispose();
            menu.Dispose();
            api.Dispose();
            owner.Dispose();
            // The lifetime token may still be observed by an unwinding request.
        }
        base.Dispose(disposing);
    }

    private static Icon CreateIcon()
    {
        using var bitmap = new Bitmap(32, 32);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.Clear(Color.Transparent);
        using var outline = new Pen(SystemInformation.HighContrast ? SystemColors.WindowText : Color.White, 2);
        using var background = new SolidBrush(SystemInformation.HighContrast ? SystemColors.Window : Color.FromArgb(24, 28, 36));
        graphics.FillRectangle(background, 3, 6, 26, 19);
        graphics.DrawRectangle(outline, 3, 6, 26, 19);
        graphics.DrawLine(outline, 11, 29, 21, 29);
        graphics.DrawLine(outline, 16, 25, 16, 29);
        graphics.DrawLines(outline, [new Point(12, 11), new Point(21, 16), new Point(12, 21), new Point(12, 11)]);
        var handle = bitmap.GetHicon();
        try { using var native = Icon.FromHandle(handle); return (Icon)native.Clone(); }
        finally { NativeMethods.DestroyIcon(handle); }
    }
}

internal sealed class TrayOwner : Form
{
    private readonly uint taskbarCreated = NativeMethods.RegisterWindowMessage("TaskbarCreated");
    public event EventHandler? ExplorerRestarted;
    public event EventHandler? SessionEnding;
    public TrayOwner()
    {
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.CenterScreen;
        Text = "HoshiStream";
    }
    protected override void SetVisibleCore(bool value) => base.SetVisibleCore(false);
    protected override void WndProc(ref Message message)
    {
        if ((uint)message.Msg == taskbarCreated) ExplorerRestarted?.Invoke(this, EventArgs.Empty);
        if (message.Msg == 0x0011)
        {
            SessionEnding?.Invoke(this, EventArgs.Empty);
            message.Result = 1;
            return;
        }
        base.WndProc(ref message);
    }
}
