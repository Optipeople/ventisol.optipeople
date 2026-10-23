using System.Globalization;
using System.Windows;
using System.Windows.Markup;

namespace Ventisol.Station;

public partial class App : Application
{
    // Errors in one handler, three times in a minute, mean something is stuck: start afresh.
    readonly Queue<DateTimeOffset> _errors = new();

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // On the shop floor a crash means scans go unread until someone notices, so an error is
        // logged and the app keeps going; a fatal one restarts it.
        DispatcherUnhandledException += (_, x) =>
        {
            Log.Write($"Error: {x.Exception}");
            x.Handled = true;
            var now = DateTimeOffset.Now;
            _errors.Enqueue(now);
            while (_errors.Peek() < now.AddMinutes(-1)) _errors.Dequeue();
            if (_errors.Count >= 3) { Log.Write("Three errors in a minute, restarting"); Restart(); }
        };
        AppDomain.CurrentDomain.UnhandledException += (_, x) =>
        {
            Log.Write($"Fatal: {x.ExceptionObject}");
            if (x.IsTerminating) StartAgain();
        };
        TaskScheduler.UnobservedTaskException += (_, x) => { Log.Write($"Background error: {x.Exception}"); x.SetObserved(); };

        // Danish dates and times everywhere, whatever the PC is set to.
        var da = CultureInfo.GetCultureInfo("da-DK");
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.DefaultThreadCurrentUICulture = da;
        Thread.CurrentThread.CurrentCulture = Thread.CurrentThread.CurrentUICulture = da;
        FrameworkElement.LanguageProperty.OverrideMetadata(typeof(FrameworkElement),
            new FrameworkPropertyMetadata(XmlLanguage.GetLanguage(da.IetfLanguageTag)));

        // --kiosk on the shop floor PC: full screen, no window buttons.
        var kiosk = e.Args.Contains("--kiosk", StringComparer.OrdinalIgnoreCase);
        // --showcase starts with sample scans on the screen.
        var showcase = e.Args.Contains("--showcase", StringComparer.OrdinalIgnoreCase);
        new MainWindow(kiosk, showcase).Show();
    }

    // A new instance takes over once this one has closed (Program waits for the single-instance lock).
    // The sample scans are for a first look only, never after a restart.
    public static void Restart()
    {
        StartAgain();
        Current.Shutdown();
    }

    static void StartAgain()
    {
        try
        {
            var args = Environment.GetCommandLineArgs().Skip(1).Where(a => !a.Equals("--showcase", StringComparison.OrdinalIgnoreCase));
            System.Diagnostics.Process.Start(Environment.ProcessPath!, args);
        }
        catch (Exception ex) { Log.Write($"Could not start again: {ex.Message}"); }
    }
}
