using Velopack;
using Ventisol.Station.Updates;

namespace Ventisol.Station;

// Our own Main, so Velopack runs before anything else. When the installer or updater starts the exe
// with one of its hook arguments, Run() handles it and exits before a window opens.
static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        VelopackApp.Build()
            // Updates go in only through UpdateService, when the floor is quiet. Not on a plain restart.
            .SetAutoApplyOnStartup(false)
            .OnAfterInstallFastCallback(_ => Autostart.Enable())
            .OnBeforeUninstallFastCallback(_ => Autostart.Disable())
            .Run();

        using var single = new Mutex(false, SingleInstance.MutexName);
        if (!TakeOver(single, args)) return;
        try
        {
            // Rolling back a version that keeps crashing.
            if (StartupGuard.Begin([.. SingleInstance.ArgsToKeep(args)])) return;
            BackOff();

            // Whether this start was a good one is App's to say: after a healthy minute, or when
            // someone closes it. Not here: Run() also returns after a failed start.
            var app = new App();
            app.InitializeComponent();
            app.Run();
        }
        finally
        {
            try { single.ReleaseMutex(); } catch { }
        }
    }

    // True when this start is the one app for its data folder.
    static bool TakeOver(Mutex single, string[] args)
    {
        if (SingleInstance.ReplacedPid(args) is not { } old)
        {
            // Started by hand, by Windows at login or by the updater. A moment is enough for an app
            // on its way out; otherwise one is running already: bring its window up and leave.
            if (SingleInstance.Take(single, TimeSpan.FromSeconds(3))) return true;
            Log.Write(SingleInstance.AskRunningToShow()
                ? "Started while the app was already running: showed its window and left"
                : "Started while the app was already running, and it did not answer: left");
            return false;
        }

        // Started by a restart: the old app is closing. Wait for it, and if it hangs, stop it, so the
        // screen is never left without an app.
        if (SingleInstance.Take(single, TimeSpan.FromSeconds(30))) return true;
        Log.Write($"The app this start replaces (process {old}) has not closed after 30 s: stopping it");
        SingleInstance.Stop(old, Log.Write);
        if (SingleInstance.Take(single, TimeSpan.FromSeconds(15))) return true;
        Log.Write("Another app still holds this data folder: left");
        return false;
    }

    // After restarts because something failed, the start waits (RestartLog), longer each time, so a
    // start that keeps failing doesn't spin. While it waits it looks for a newer version and installs
    // it at once: there is no window up to disturb, and a fixed release is the way out of the loop.
    static void BackOff()
    {
        var now = DateTimeOffset.Now;
        var wait = App.Restarts.WaitBeforeStart(now);
        if (wait <= TimeSpan.Zero) return;
        Log.Write($"Restarted {App.Restarts.Count(now)} times in the last hour after errors: waiting {wait.TotalSeconds:0} s before starting, and looking for a newer version meanwhile");

        using var updates = new UpdateService(UpdateService.DefaultUrl, () => true, Log.Write);
        updates.Start();
        // An update on its way in is given time to finish; installing ends this process.
        var until = now + wait;
        var atLatest = until + TimeSpan.FromMinutes(10);
        while (DateTimeOffset.Now < until || updates.IsBusy && DateTimeOffset.Now < atLatest)
            Thread.Sleep(500);
    }
}
