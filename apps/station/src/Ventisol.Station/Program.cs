using System.Security.Cryptography;
using System.Text;
using System.Windows.Threading;
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

        // One app per data folder: two would read the same cradles and send the same outbox. A restart
        // starts the new one before the old has closed, so it waits a while for the old to let go.
        using var single = new Mutex(false, $@"Local\VentisolStation-{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(AppPaths.Data.ToUpperInvariant())))[..16]}");
        try { if (!single.WaitOne(TimeSpan.FromSeconds(20))) return; }
        catch (AbandonedMutexException) { } // The old one was killed; the lock is ours now.

        if (StartupGuard.Begin(args)) return; // Rolling back a version that keeps crashing.

        var app = new App();
        app.InitializeComponent();
        // A minute up counts as a good start.
        app.Startup += (_, _) => new DispatcherTimer(TimeSpan.FromMinutes(1), DispatcherPriority.Background,
            (s, _) => { ((DispatcherTimer)s!).Stop(); StartupGuard.Succeeded(); }, app.Dispatcher);
        app.Run();
        StartupGuard.Succeeded(); // Closed normally: not a crash.
        single.ReleaseMutex();
    }
}
