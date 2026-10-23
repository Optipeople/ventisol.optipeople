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

        if (StartupGuard.Begin(args)) return; // Rolling back a version that keeps crashing.

        var app = new App();
        app.InitializeComponent();
        // A minute up counts as a good start.
        app.Startup += (_, _) => new DispatcherTimer(TimeSpan.FromMinutes(1), DispatcherPriority.Background,
            (s, _) => { ((DispatcherTimer)s!).Stop(); StartupGuard.Succeeded(); }, app.Dispatcher);
        app.Run();
        StartupGuard.Succeeded(); // Closed normally: not a crash.
    }
}
