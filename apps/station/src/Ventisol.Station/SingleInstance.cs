using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace Ventisol.Station;

// One app per data folder: two would read the same cradles and send the same outbox.
// A restart starts the new app before the old one has closed and tells it which process it replaces,
// so the new one can wait for it, and stop it if it never lets go. A second start by hand asks the
// running app to show its window and leaves.
static class SingleInstance
{
    const string ReplacesArg = "--replaces=";

    static readonly string Key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(AppPaths.Data.ToUpperInvariant())))[..16];

    public static string MutexName => $@"Local\VentisolStation-{Key}";
    static string ShowName => $@"Local\VentisolStation-{Key}-show";

    // True when the lock is ours. A lock left behind by a killed app counts.
    public static bool Take(Mutex mutex, TimeSpan wait)
    {
        try { return mutex.WaitOne(wait); }
        catch (AbandonedMutexException) { return true; }
    }

    // The process this start takes over from, when it was started by a restart.
    public static int? ReplacedPid(IEnumerable<string> args)
    {
        var arg = args.LastOrDefault(a => a.StartsWith(ReplacesArg, StringComparison.OrdinalIgnoreCase));
        return arg is not null && int.TryParse(arg[ReplacesArg.Length..], out var pid) && pid > 0 ? pid : null;
    }

    // The arguments a new start of this app gets: the same ones (so a kiosk stays a kiosk), without
    // the sample scans, which are for a first look only, and without an older "replaces".
    public static List<string> ArgsToKeep(IEnumerable<string> args) =>
        [.. args.Where(a => !a.Equals("--showcase", StringComparison.OrdinalIgnoreCase)
                            && !a.StartsWith(ReplacesArg, StringComparison.OrdinalIgnoreCase))];

    public static List<string> ArgsForRestart(IEnumerable<string> args) =>
        [.. ArgsToKeep(args), $"{ReplacesArg}{Environment.ProcessId}"];

    // Stops the old app, when the process with that id still is one: same program as this, started before this.
    public static void Stop(int pid, Action<string> log)
    {
        try
        {
            using var me = Process.GetCurrentProcess();
            using var old = Process.GetProcessById(pid);
            if (!old.ProcessName.Equals(me.ProcessName, StringComparison.OrdinalIgnoreCase) || old.StartTime > me.StartTime)
            {
                log($"Process {pid} is not the app we replace ({old.ProcessName}): left alone");
                return;
            }
            old.Kill();
            log(old.WaitForExit(10_000) ? $"Process {pid} stopped" : $"Process {pid} did not stop");
        }
        catch (ArgumentException) { log($"Process {pid} is already gone"); }
        catch (Exception e) { log($"Process {pid} could not be stopped: {e.Message}"); }
    }

    // Asks the running app to bring its window up. False when none is listening.
    public static bool AskRunningToShow()
    {
        try
        {
            if (!EventWaitHandle.TryOpenExisting(ShowName, out var signal)) return false;
            using (signal) return signal.Set();
        }
        catch { return false; }
    }

    // Calls show (on a pool thread) every time another start asks for the window. Dispose to stop.
    public static IDisposable? ListenForShow(Action show, Action<string> log)
    {
        try
        {
            var signal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowName);
            var wait = ThreadPool.RegisterWaitForSingleObject(signal, (_, _) =>
            {
                try { show(); }
                catch (Exception e) { log($"Could not show the window: {e.Message}"); }
            }, null, Timeout.Infinite, executeOnlyOnce: false);
            return new Listener(signal, wait);
        }
        catch (Exception e)
        {
            log($"Not listening for a second start: {e.Message}");
            return null;
        }
    }

    sealed class Listener(EventWaitHandle signal, RegisteredWaitHandle wait) : IDisposable
    {
        public void Dispose()
        {
            wait.Unregister(null);
            signal.Dispose();
        }
    }
}
