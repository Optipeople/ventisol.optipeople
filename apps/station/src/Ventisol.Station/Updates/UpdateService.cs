using System.ComponentModel;
using System.Windows;
using Velopack;
using Velopack.Sources;

namespace Ventisol.Station.Updates;

// Checks for a new version every hour, downloads it in the background, and installs it only when the floor
// is quiet (the caller's isQuiet) or at night, never in the middle of a shift. Installing closes the app,
// swaps the version and starts it again with the same arguments.
// The URL is a public GitHub repo with the releases (the code repo is private, and a token on every PC is
// not wanted), or a plain URL or folder with a Velopack feed. Status and StatusChanged come on the thread
// that called Start.
public sealed class UpdateService(string updateUrl, Func<bool> isQuiet, Action<string> log) : INotifyPropertyChanged, IDisposable
{
    public const string DefaultUrl = "https://github.com/Optipeople/ventisol-station-updates";

    static readonly TimeSpan CheckEvery = TimeSpan.FromHours(1);
    // How often a downloaded update looks for its quiet moment.
    static readonly TimeSpan Poll = TimeSpan.FromMinutes(1);
    const int NightFrom = 22, NightTo = 5;

    readonly CancellationTokenSource _cts = new();
    SynchronizationContext? _context;
    bool _started;

    public string Status { get; private set; } = "Ikke installeret";
    public event EventHandler<string>? StatusChanged;
    public event PropertyChangedEventHandler? PropertyChanged;

    public void Start()
    {
        if (_started) return;
        _started = true;
        _context = SynchronizationContext.Current;

        UpdateManager? manager = null;
        try { if (!string.IsNullOrWhiteSpace(updateUrl)) manager = Create(updateUrl.Trim()); }
        catch (Exception ex) { log($"Updates: {ex.Message}"); }
        // A dev run, or no URL: nothing to update.
        if (manager is not { IsInstalled: true }) { SetStatus("Ikke installeret"); return; }

        log($"Updates: version {manager.CurrentVersion}, checking {updateUrl} every hour");
        _ = Task.Run(() => RunAsync(manager, _cts.Token));
    }

    public void Dispose() => _cts.Cancel();

    static UpdateManager Create(string url) =>
        url.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase)
            ? new UpdateManager(new GithubSource(url, accessToken: null, prerelease: false))
            : new UpdateManager(url);

    async Task RunAsync(UpdateManager manager, CancellationToken ct)
    {
        // Downloaded before a restart: still waiting for its quiet moment.
        var ready = manager.UpdatePendingRestart is { } pending && !StartupGuard.IsBad(pending.Version.ToString()) ? pending : null;
        if (ready is not null) SetStatus(Waiting(ready));
        var nextCheck = DateTimeOffset.MinValue;
        try
        {
            while (true)
            {
                if (DateTimeOffset.Now >= nextCheck)
                {
                    nextCheck = DateTimeOffset.Now + CheckEvery;
                    ready = await CheckAsync(manager, ct) ?? ready;
                    if (ready is not null) SetStatus(Waiting(ready));
                }
                if (ready is not null && CanInstallNow())
                {
                    Install(manager, ready);
                    return;
                }
                await Task.Delay(Poll, ct);
            }
        }
        catch (OperationCanceledException) { }
    }

    // The newest version, downloaded and ready to install, or null when there is none (or it failed).
    async Task<VelopackAsset?> CheckAsync(UpdateManager manager, CancellationToken ct)
    {
        SetStatus("Søger…");
        try
        {
            var info = await manager.CheckForUpdatesAsync();
            if (info is null) { SetStatus("Opdateret"); return null; }
            var target = info.TargetFullRelease;
            if (StartupGuard.IsBad(target.Version.ToString()))
            {
                SetStatus($"Version {target.Version} springes over, den kunne ikke starte");
                return null;
            }

            StartupGuard.KeepForRollback();
            SetStatus($"Henter version {target.Version}…");
            await manager.DownloadUpdatesAsync(info, cancelToken: ct);
            log($"Updates: version {target.Version} downloaded");
            return target;
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            log($"Updates: {ex.Message}");
            SetStatus($"Fejl: {ex.Message}");
            return null;
        }
    }

    bool CanInstallNow()
    {
        var hour = DateTime.Now.Hour;
        if (hour >= NightFrom || hour < NightTo) return true;
        try { return isQuiet(); }
        catch { return false; }
    }

    void Install(UpdateManager manager, VelopackAsset target)
    {
        SetStatus($"Installerer version {target.Version}…");
        log($"Updates: installing version {target.Version} and restarting");
        try
        {
            // The updater waits for the app to close, so it can save its state on the way out first.
            manager.WaitExitThenApplyUpdates(target, silent: true, restart: true, Environment.GetCommandLineArgs()[1..]);
            if (Application.Current is { } app) app.Dispatcher.BeginInvoke(() => app.Shutdown());
            else Environment.Exit(0);
        }
        catch (Exception ex)
        {
            log($"Updates: install failed: {ex.Message}");
            SetStatus($"Fejl: {ex.Message}");
        }
    }

    static string Waiting(VelopackAsset target) => $"Ny version {target.Version} klar, installeres når der er roligt";

    void SetStatus(string status)
    {
        void Raise()
        {
            if (Status == status) return;
            Status = status;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Status)));
            StatusChanged?.Invoke(this, status);
        }
        if (_context is null || _context == SynchronizationContext.Current) Raise();
        else _context.Post(_ => Raise(), null);
    }
}
