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

            // Whether this start was a good one is App's to say: after a healthy minute, or when
            // someone closes it. Not here: Run() also returns after a failed start. After restarts
            // because something failed, App waits before it builds its window (App.WaitThenOpen).
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
}
