namespace HoshiStream.Windows;

internal sealed class SleepInhibitor : IDisposable
{
    private readonly AutoResetEvent changed = new(false);
    private readonly Thread thread;
    private readonly SafeLog log;
    private volatile bool streaming, stopping;
    private long lastStatus;

    public SleepInhibitor(SafeLog log)
    {
        this.log = log;
        thread = new Thread(Run) { IsBackground = true, Name = "HoshiStream playback power request" };
        thread.Start();
    }
    public void Update(bool active)
    {
        streaming = active;
        Interlocked.Exchange(ref lastStatus, Environment.TickCount64);
        changed.Set();
    }
    private void Run()
    {
        var held = false;
        try
        {
            while (!stopping)
            {
                var required = streaming && Environment.TickCount64 - Interlocked.Read(ref lastStatus) < 10_000;
                if (required != held)
                {
                    // ES_SYSTEM_REQUIRED prevents idle system sleep only. Never
                    // request ES_DISPLAY_REQUIRED or ES_AWAYMODE_REQUIRED.
                    if (NativeMethods.SetThreadExecutionState(0x80000000u | (required ? 1u : 0u)) == 0)
                        log.Event("sleep_request_failed");
                    else held = required;
                }
                changed.WaitOne(1000);
            }
        }
        finally { NativeMethods.SetThreadExecutionState(0x80000000); }
    }
    public void Dispose()
    {
        stopping = true;
        changed.Set();
        thread.Join();
        changed.Dispose();
    }
}
