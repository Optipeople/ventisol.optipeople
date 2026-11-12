using System.Globalization;
using System.Windows;
using System.Windows.Markup;
using System.Windows.Threading;
using Ventisol.Station.Updates;

namespace Ventisol.Station;

public partial class App : Application
{
    // Restarts the app made itself after errors, kept on disk: what breaks a restart loop.
    internal static readonly RestartLog Restarts = new(AppPaths.Data, Log.Write);
    // The optional PIN in front of the setup screen.
    internal static readonly SetupPin Pin = new(AppPaths.Data, Log.Write);

    // Full screen, no window buttons, and no way out but the tray: the shop floor PC.
    public static bool Kiosk { get; private set; }
    // Looks for new versions from before the window is built, so a version whose window can't be
    // built still gets the next one. Null in a developer's snapshot run.
    public static UpdateService? Updates { get; private set; }
    // The app is closing on purpose (a restart, an update, "Luk"), so the kiosk window lets go.
    public static bool Exiting { get; private set; }

    // Someone closed the app: that is a good end, not a crash.
    static bool _closedByUser;

    // Errors in one handler, three times in a minute, mean something is stuck: start afresh.
    readonly Queue<DateTimeOffset> _errors = new();
    DateTimeOffset _lastError = DateTimeOffset.MinValue;
    MainWindow? _window;
    TrayIcon? _tray;
    IDisposable? _showListener;
    DispatcherTimer? _healthy;
    // The start is waiting after failed ones (WaitThenOpen). Read by the update service's thread too.
    volatile bool _waiting;
    // Ends that wait and starts now. Null when not waiting.
    Action? _startNow;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // On the shop floor a crash means scans go unread until someone notices, so an error is
        // logged and the app keeps going; a fatal one restarts it.
        DispatcherUnhandledException += (_, x) =>
        {
            x.Handled = true;
            OnError(x.Exception);
        };
        AppDomain.CurrentDomain.UnhandledException += (_, x) =>
        {
            Log.Write($"Fatal: {x.ExceptionObject}");
            if (!x.IsTerminating || Exiting) return;
            // OnExit doesn't run on a crash: take the tray icon away, or a dead one stays next to the new one.
            try { _tray?.Dispose(); } catch { }
            NoteFailure();
            StartAgain();
        };
        TaskScheduler.UnobservedTaskException += (_, x) => { Log.Write($"Background error: {x.Exception}"); x.SetObserved(); };

        // Danish dates and times everywhere, whatever the PC is set to.
        var da = CultureInfo.GetCultureInfo("da-DK");
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.DefaultThreadCurrentUICulture = da;
        Thread.CurrentThread.CurrentCulture = Thread.CurrentThread.CurrentUICulture = da;
        FrameworkElement.LanguageProperty.OverrideMetadata(typeof(FrameworkElement),
            new FrameworkPropertyMetadata(XmlLanguage.GetLanguage(da.IetfLanguageTag)));

        // A developer's picture of the document screen (Documents/DocumentSnapshot.cs), then exit.
        if (e.Args.Contains(Documents.DocumentSnapshot.Flag, StringComparer.OrdinalIgnoreCase))
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            Documents.DocumentSnapshot.Run(this, e.Args);
            return;
        }

        // --kiosk on the shop floor PC: full screen, no window buttons. The installed app is set to
        // start that way at login (Autostart), and then every start of it is a kiosk: the first one
        // after the install and the one after an update too. --window opens it as a window anyway.
        Kiosk = e.Args.Contains("--kiosk", StringComparer.OrdinalIgnoreCase)
                || Autostart.IsKiosk() && !e.Args.Contains("--window", StringComparer.OrdinalIgnoreCase);
        // --showcase starts with sample scans on the screen.
        var showcase = e.Args.Contains("--showcase", StringComparer.OrdinalIgnoreCase);

        // A second start of the app brings this one's window up instead of opening another. While
        // this one waits before it starts (below), it starts now: someone is at the PC and wants the app.
        _showListener = SingleInstance.ListenForShow(() => Dispatcher.BeginInvoke(OnShowAsked), Log.Write);

        // Before the window, so a version that can't build its window still finds the next one.
        // An update restarts the app, so it waits until no scan has come in for 10 minutes (or night),
        // and for the setup screen and the layout mode to be left. During the wait before a start
        // there is no window up to disturb: it goes in at once, as a fixed release is the way out.
        Updates = new UpdateService(UpdateService.DefaultUrl,
            isQuiet: () => _waiting || (_window?.IsQuiet ?? false), Log.Write, inUse: () => _window?.InUse ?? false);
        Updates.Start();

        WaitThenOpen(showcase);
    }

    // After restarts because something failed, the start waits (RestartLog), longer each time, so a
    // start that keeps failing doesn't spin. Meanwhile the update service looks for a newer version,
    // and a small window says the app is on its way, so the PC never looks dead: its "Start nu", or
    // starting the app by hand, ends the wait.
    void WaitThenOpen(bool showcase)
    {
        var now = DateTimeOffset.Now;
        var wait = Restarts.WaitBeforeStart(now);
        if (wait <= TimeSpan.Zero) { Open(showcase); return; }
        Log.Write($"Restarted {Restarts.Count(now)} times in the last hour after errors: waiting {wait.TotalSeconds:0} s before starting, and looking for a newer version meanwhile");

        // An update on its way in is given time to finish; installing ends this process.
        var until = now + wait;
        var atLatest = until + TimeSpan.FromMinutes(10);
        // The notice closes before the window opens: that must not end the app.
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        _waiting = true;

        StartNotice? notice = null;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        void Start(string why)
        {
            if (!_waiting) return;
            _waiting = false;
            _startNow = null;
            timer.Stop();
            try { notice?.Close(); } catch { }
            if (Exiting) return;
            Log.Write(why);
            ShutdownMode = ShutdownMode.OnLastWindowClose;
            Open(showcase);
        }
        _startNow = () => Start("Started before the wait was over: someone asked for the app");
        // A notice that fails is dropped: it must never restart the app or keep the wait from ending.
        void Tell(Action<StartNotice> show)
        {
            if (notice is null) return;
            try { show(notice); }
            catch (Exception ex)
            {
                Log.Write($"The start notice failed, waiting without it: {ex.Message}");
                try { notice.Close(); } catch { }
                notice = null;
            }
        }
        timer.Tick += Ui.SafeTick(() =>
        {
            var t = DateTimeOffset.Now;
            if (t < until) Tell(n => n.ShowWait(until - t));
            else if (Updates is { IsBusy: true } && t < atLatest) Tell(n => n.ShowUpdating());
            else Start("The wait is over, starting");
        });
        timer.Start();

        // The wait is what matters; it runs with or without its notice.
        try
        {
            notice = new StartNotice();
            notice.StartNow += (_, _) => _startNow?.Invoke();
            notice.ShowWait(wait);
            notice.Show();
        }
        catch (Exception ex)
        {
            Log.Write($"The start notice could not be shown: {ex.Message}");
            notice = null;
            // A window is among the app's windows from its constructor on: a half made notice must
            // not stay up, or stay in the way of the kiosk taking the foreground.
            try { foreach (var half in Windows.OfType<StartNotice>().ToList()) half.Close(); } catch { }
        }
    }

    void OnShowAsked()
    {
        if (_startNow is { } startNow) startNow();
        else _window?.BringUp();
    }

    void Open(bool showcase)
    {
        MainWindow window;
        try
        {
            window = new MainWindow(Kiosk, showcase);
            window.Show();
        }
        catch (Exception ex)
        {
            // Without this the error handler above keeps a process with no window alive, and it holds
            // the single-instance lock, so the app can't be opened again. A saved layout is the likely
            // cause (a widget that can't be drawn): set it aside and start on the default one. The next
            // start waits first, longer each time (RestartLog), and looks for a newer version meanwhile.
            Log.Write($"Window could not be shown: {ex}");
            if (LayoutStore.SetAside()) Log.Write("Layout set aside, starting again on the default layout");
            // No new app and no window here: close, or this process holds the single-instance lock
            // and the app can't be opened by hand either.
            if (!RestartAfterFailure())
            {
                Exiting = true;
                Shutdown(1);
            }
            return;
        }
        _window = window;
        _tray = new TrayIcon(window, (ViewModels.MainViewModel)window.DataContext);

        // A minute up, and a minute without an error, counts as a good start (StartupGuard).
        _healthy = new DispatcherTimer(TimeSpan.FromMinutes(1), DispatcherPriority.Background, Ui.SafeTick(() =>
        {
            if (Exiting) { _healthy?.Stop(); return; }
            if (DateTimeOffset.Now - _lastError < TimeSpan.FromMinutes(1)) return; // Look again in a minute.
            _healthy?.Stop();
            StartupGuard.Succeeded();
        }), Dispatcher);
    }

    // An error the app carries on after: logged, and counted. Three in a minute mean something is
    // stuck, and the app starts afresh. Brief is a timer's error that repeats (Ui.SafeTick): one line,
    // and not counted, so a tick that fails every time can't restart the app over and over. It still
    // keeps the start from being called a good one.
    void OnError(Exception ex, bool brief = false)
    {
        Log.Write(brief ? $"Error: {ex.GetType().Name}: {ex.Message}" : $"Error: {ex}");
        var now = DateTimeOffset.Now;
        _lastError = now;
        if (brief) return;
        _errors.Enqueue(now);
        while (_errors.Peek() < now.AddMinutes(-1)) _errors.Dequeue();
        if (_errors.Count >= 3 && !Exiting)
        {
            Log.Write("Three errors in a minute, restarting");
            // Not started again: this app stays, and the next three errors try once more.
            if (!RestartAfterFailure()) _errors.Clear();
        }
    }

    // An error caught on the UI thread (a timer's tick): the same log line and count as one that
    // reached the dispatcher.
    internal static void NoteError(Exception ex, bool brief = false)
    {
        if (Current is App app) app.OnError(ex, brief);
        else Log.Write($"Error: {ex}");
    }

    // The tray menu is up (it is no window of WPF's, but it is the app's).
    internal static bool TrayMenuOpen => Current is App { _tray.MenuOpen: true };

    // Windows is logging off or shutting down. That says nothing about this version, so the start is
    // neither a good one nor a failed one.
    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        base.OnSessionEnding(e);
        if (e.Cancel) return;
        Exiting = true;
        // Also during the wait before a start, when there is no window yet.
        StartupGuard.NotCounted();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _healthy?.Stop();
        _showListener?.Dispose();
        _tray?.Dispose();
        Updates?.Dispose();
        if (_closedByUser) StartupGuard.Succeeded();
        base.OnExit(e);
    }

    // A new instance takes over once this one has closed (Program waits for the single-instance lock).
    // For a restart someone asked for, or one that is part of the work (new settings). It says nothing
    // about the version, so this start is neither a good one nor a failed one: three saves in the
    // setup within a minute of an update must not roll the update back.
    public static void Restart()
    {
        StartupGuard.NotCounted();
        Relaunch();
    }

    // False when the new app could not be started. Then this one stays: a kiosk with an app that
    // should have restarted is better than a kiosk with no app.
    static bool Relaunch()
    {
        if (!StartAgain())
        {
            Log.Write("Not restarting: the app keeps running as it is");
            return false;
        }
        Exiting = true;
        Current.Shutdown();
        return true;
    }

    // "Luk" in the tray: the one way to close a kiosk.
    public static void CloseByUser()
    {
        NoteClosedByUser();
        Current.Shutdown();
    }

    // The window was closed by its user (outside kiosk mode).
    public static void NoteClosedByUser()
    {
        Exiting = true;
        _closedByUser = true;
    }

    // Closing for an update that is being installed. That says nothing about this version, so a
    // version not yet proven does not get a failed start for it.
    public static void ExitForUpdate()
    {
        Exiting = true;
        StartupGuard.NotCounted();
        Current.Shutdown();
    }

    // A restart because something failed. Counted, so the next start waits when they pile up.
    // False when no new app was started (see Relaunch).
    static bool RestartAfterFailure()
    {
        if (Exiting) return true;
        NoteFailure();
        return Relaunch();
    }

    static void NoteFailure()
    {
        try
        {
            var count = Restarts.Record(DateTimeOffset.Now);
            Log.Write($"Restart {count} in the last hour after an error; the next start waits {RestartLog.DelayFor(count).TotalSeconds:0} s");
            // The layout is the one thing on this PC that can make every start fail the same way.
            if (count >= RestartLog.SetLayoutAsideAt && LayoutStore.SetAside()) Log.Write("Layout set aside, the next start uses the default layout");
        }
        catch (Exception ex) { Log.Write($"Restart not noted: {ex.Message}"); }
    }

    // The new app gets the same arguments (a kiosk stays a kiosk) and this process' id, so it can
    // wait for this one and stop it if it hangs on the way out.
    // False when it could not be started.
    static bool StartAgain()
    {
        try
        {
            return System.Diagnostics.Process.Start(Environment.ProcessPath!, SingleInstance.ArgsForRestart(Environment.GetCommandLineArgs().Skip(1))) is not null;
        }
        catch (Exception ex)
        {
            Log.Write($"Could not start again: {ex.Message}");
            return false;
        }
    }
}
