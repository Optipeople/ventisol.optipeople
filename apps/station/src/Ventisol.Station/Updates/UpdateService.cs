using System.ComponentModel;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Windows;
using Ventisol.Station.Core;
using Velopack;
using Velopack.Sources;

namespace Ventisol.Station.Updates;

// Looks every minute for a new version, downloads it in the background, and installs it only when the floor
// is quiet (the caller's isQuiet) or at night, never in the middle of a shift, and never while someone is
// using the screen for something an install would throw away (the caller's inUse: the setup screen, a
// layout being arranged). Installing closes the app, swaps the version and starts it again with the same
// arguments. A check, download or install that fails is tried again, a little later each time.
// The URL is a public GitHub repo with the releases (the code repo is private, and a token on every PC is
// not wanted), or a plain URL or folder with a Velopack feed. The minute look reads the latest release's
// feed file from its download link (ReleaseFeed), not GitHub's API, which allows only 60 calls an hour per
// IP for all the PCs in the factory together. Only a new version, or the hourly fallback, makes the API call.
// Status and StatusChanged come on the thread that called Start.
public sealed class UpdateService(string updateUrl, Func<bool> isQuiet, Action<string> log, Func<bool>? inUse = null) : INotifyPropertyChanged, IDisposable
{
    public const string DefaultUrl = "https://github.com/Optipeople/ventisol.station.updates";

    // The full check through GitHub's API, also when the minute look sees nothing new.
    static readonly TimeSpan CheckEvery = TimeSpan.FromHours(1);
    // How often we look for a new version, and a downloaded update looks for its quiet moment.
    static readonly TimeSpan Poll = TimeSpan.FromMinutes(1);
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    const int NightFrom = 22, NightTo = 5;
    // After an install that failed, the next try waits this long, so the log is not filled every minute.
    static readonly TimeSpan InstallRetry = TimeSpan.FromMinutes(10);

    readonly CancellationTokenSource _cts = new();
    SynchronizationContext? _context;
    bool _started;
    readonly string? _feedUrl = ReleaseFeed.LatestFeedUrl(updateUrl ?? "");
    // The newest version a check has already dealt with (downloaded, or skipped as bad by StartupGuard),
    // so it doesn't cost an API call every minute. Set only after the check went through: a download
    // that failed is tried again.
    Version? _seen;
    volatile bool _busy;

    // True while a check, a download or an install is under way.
    public bool IsBusy => _busy;

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

        log($"Updates: version {manager.CurrentVersion}, checking {updateUrl} every minute");
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
        // After a check that failed: when the minute look may start the next one, later each time.
        var retryAt = DateTimeOffset.MinValue;
        var failures = 0;
        var installAt = DateTimeOffset.MinValue;
        try
        {
            while (true)
            {
                _busy = true;
                var now = DateTimeOffset.Now;
                Version? latest = null;
                if (now >= nextCheck || now >= retryAt && (latest = await NewVersionOutAsync(manager, ready, ct)) is not null)
                {
                    nextCheck = now + CheckEvery;
                    var (target, failed) = await CheckAsync(manager, ct);
                    if (failed)
                    {
                        // Not marked as seen, so the minute look starts another check: after 1, 2, 4 ... minutes.
                        failures++;
                        retryAt = DateTimeOffset.Now + TimeSpan.FromTicks(Math.Min(CheckEvery.Ticks, Poll.Ticks << Math.Min(failures - 1, 10)));
                    }
                    else
                    {
                        failures = 0;
                        retryAt = DateTimeOffset.MinValue;
                        if (latest is not null) _seen = latest;
                    }
                    ready = target ?? ready;
                    if (ready is not null && !failed) SetStatus(Waiting(ready));
                }
                if (ready is not null && DateTimeOffset.Now >= installAt && CanInstallNow())
                {
                    // Installed: the app is closing, and stays busy until it has.
                    if (Install(manager, ready)) return;
                    installAt = DateTimeOffset.Now + InstallRetry;
                }
                _busy = false;
                await Task.Delay(Poll, ct);
            }
        }
        catch (OperationCanceledException) { _busy = false; }
        catch (Exception ex)
        {
            // Not expected: every step above catches its own errors. Say so rather than stop in silence.
            _busy = false;
            log($"Updates: stopped looking: {ex}");
            SetStatus($"Fejl: {ex.Message}");
        }
    }

    // The latest release's version when it is newer than what is running or already downloaded, and no
    // check has dealt with it yet. Cheap, and null on any error: the hourly check is the fallback.
    async Task<Version?> NewVersionOutAsync(UpdateManager manager, VelopackAsset? ready, CancellationToken ct)
    {
        if (_feedUrl is null) return null;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, _feedUrl);
            request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
            using var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) return null;
            var latest = ReleaseFeed.LatestFullVersion(await response.Content.ReadAsStringAsync(ct));
            var have = ReleaseFeed.ParseVersion((ready?.Version ?? manager.CurrentVersion)?.ToString());
            if (latest is null || have is null || latest <= have || latest == _seen) return null;
            log($"Updates: version {latest} is out");
            return latest;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception) { return null; }
    }

    // The newest version, downloaded and ready to install, or null when there is none. Failed is true
    // when the check or the download went wrong, so the caller tries again.
    async Task<(VelopackAsset? Target, bool Failed)> CheckAsync(UpdateManager manager, CancellationToken ct)
    {
        SetStatus("Søger…");
        try
        {
            var info = await manager.CheckForUpdatesAsync();
            if (info is null) { SetStatus("Opdateret"); return (null, false); }
            var target = info.TargetFullRelease;
            if (StartupGuard.IsBad(target.Version.ToString()))
            {
                SetStatus($"Version {target.Version} springes over, den kunne ikke starte");
                return (null, false);
            }

            StartupGuard.KeepForRollback();
            SetStatus($"Henter version {target.Version}…");
            await manager.DownloadUpdatesAsync(info, cancelToken: ct);
            log($"Updates: version {target.Version} downloaded");
            return (target, false);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            log($"Updates: {ex.Message}");
            SetStatus($"Fejl: {ex.Message}");
            return (null, true);
        }
    }

    // Night is a good time only when nobody is at the screen: an open setup or a layout being
    // arranged holds an install back at any hour.
    bool CanInstallNow()
    {
        try
        {
            if (inUse?.Invoke() == true) return false;
            var hour = DateTime.Now.Hour;
            return hour >= NightFrom || hour < NightTo || isQuiet();
        }
        catch { return false; }
    }

    // True when the install is under way and the app is closing. False when it could not be started:
    // the caller keeps looking and tries again.
    bool Install(UpdateManager manager, VelopackAsset target)
    {
        SetStatus($"Installerer version {target.Version}…");
        log($"Updates: installing version {target.Version} and restarting");
        try
        {
            // The updater waits for the app to close, so it can save its state on the way out first.
            manager.WaitExitThenApplyUpdates(target, silent: true, restart: true,
                [.. SingleInstance.ArgsToKeep(Environment.GetCommandLineArgs().Skip(1))]);
        }
        catch (Exception ex)
        {
            log($"Updates: install failed: {ex.Message}");
            SetStatus($"Fejl: {ex.Message}");
            return false;
        }
        // Past this point the updater is waiting for us: close, whatever else happens.
        try
        {
            if (Application.Current is { } app) app.Dispatcher.BeginInvoke(App.ExitForUpdate);
            else Environment.Exit(0);
        }
        catch (Exception ex)
        {
            log($"Updates: could not close for the install, exiting: {ex.Message}");
            Environment.Exit(0);
        }
        return true;
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
