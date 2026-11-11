using System.IO;
using System.Text.Json;
using Velopack;
using Velopack.Locators;

namespace Ventisol.Station.Updates;

// Rolls back an update that keeps crashing on startup. Velopack has no rollback of its own and keeps only the
// newest package, so UpdateService saves the running version's package before it updates (KeepForRollback).
// A start is good when the app has run for a minute without an error, or when someone closed it (App says
// which). A start that ends in a restart, a crash or an exit code is not. After MaxFailedStarts bad starts in a
// row on a version we just updated to, the saved package is put back and applied, and the version is marked
// bad so UpdateService won't install it again. A newer release clears that. Never throws.
static class StartupGuard
{
    const int MaxFailedStarts = 3;

    static readonly string Folder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Ventisol", "Station", "updates");
    static readonly string StateFile = Path.Combine(Folder, "guard.json");
    static readonly string RollbackFolder = Path.Combine(Folder, "rollback");

    sealed class State
    {
        public string Version { get; set; } = "";
        public string? Previous { get; set; }
        public int FailedStarts { get; set; }
        public bool Proven { get; set; } // Started well once: later crashes are not the update's fault.
        public List<string> Bad { get; set; } = [];
    }

    // Counts this start. True when it has started a rollback and the app must exit now.
    public static bool Begin(string[] args)
    {
        try
        {
            var locator = VelopackLocator.IsCurrentSet ? VelopackLocator.Current : null;
            var version = locator?.CurrentlyInstalledVersion?.ToString();
            if (locator is null || version is null) return false; // Dev run: nothing installed to guard.

            var s = Load();
            if (s.Version != version)
            {
                s.Previous = s.Version == "" ? null : s.Version;
                s.Version = version;
                s.FailedStarts = 0;
                s.Proven = false;
            }
            s.FailedStarts++;
            Save(s);
            if (s.Proven || s.FailedStarts <= MaxFailedStarts || s.Previous is null) return false;
            return RollBack(locator, s, args);
        }
        catch (Exception ex) { Log.Write($"Startup guard: {ex.Message}"); return false; }
    }

    public static void Succeeded()
    {
        try
        {
            var s = Load();
            if (s.Version == "" || (s.Proven && s.FailedStarts == 0)) return;
            s.FailedStarts = 0;
            s.Proven = true;
            Save(s);
        }
        catch (Exception ex) { Log.Write($"Startup guard: good start not saved: {ex.Message}"); } // Worst case the next start counts one too many.
    }

    // This start ended for a reason that says nothing about the version (Windows shutting down, or a
    // restart someone asked for, within the first minute): take it out of the count again, without
    // calling the version proven.
    public static void NotCounted()
    {
        try
        {
            var s = Load();
            if (s.Version == "" || s.Proven || s.FailedStarts == 0) return;
            s.FailedStarts--;
            Save(s);
        }
        catch { }
    }

    public static bool IsBad(string version)
    {
        try { return Load().Bad.Contains(version); }
        catch { return false; }
    }

    // Copies the running version's full package aside, before an update replaces it.
    public static void KeepForRollback()
    {
        try
        {
            if (!VelopackLocator.IsCurrentSet) return;
            var locator = VelopackLocator.Current;
            var current = locator.CurrentlyInstalledVersion;
            var package = locator.GetLocalPackages().FirstOrDefault(p => p.Type == VelopackAssetType.Full && p.Version.Equals(current));
            if (package is null) { Log.Write($"Rollback: no local package for {current}, can't roll back to it"); return; }
            var source = Path.Combine(locator.PackagesDir!, package.FileName);
            var target = Path.Combine(RollbackFolder, package.FileName);
            if (File.Exists(target)) return;
            Directory.CreateDirectory(RollbackFolder);
            foreach (var old in Directory.GetFiles(RollbackFolder)) File.Delete(old);
            File.Copy(source, target);
        }
        catch (Exception ex) { Log.Write($"Rollback package not saved: {ex.Message}"); }
    }

    static bool RollBack(IVelopackLocator locator, State s, string[] args)
    {
        var saved = Directory.Exists(RollbackFolder)
            ? Directory.GetFiles(RollbackFolder, $"*-{s.Previous}-full.nupkg").FirstOrDefault()
            : null;
        if (saved is null)
        {
            Log.Write($"Version {s.Version} failed to start {s.FailedStarts} times, but no saved package for {s.Previous}: can't roll back");
            return false;
        }

        Log.Write($"Version {s.Version} failed to start {s.FailedStarts} times: rolling back to {s.Previous}");
        if (!s.Bad.Contains(s.Version)) s.Bad.Add(s.Version);
        Save(s);

        // The bad version's packages go, so nothing applies it again on its own.
        var packages = locator.PackagesDir!;
        foreach (var p in Directory.GetFiles(packages, $"*-{s.Version}-*.nupkg")) File.Delete(p);
        File.Copy(saved, Path.Combine(packages, Path.GetFileName(saved)), overwrite: true);

        var asset = locator.GetLocalPackages().First(p => p.Type == VelopackAssetType.Full && p.Version.ToString() == s.Previous);
        new UpdateManager(RollbackFolder, new UpdateOptions { AllowVersionDowngrade = true }, locator)
            .ApplyUpdatesAndRestart(asset, args);
        return true;
    }

    static State Load()
    {
        try
        {
            // Null on a first start: nothing saved yet.
            return AtomicFile.TryRead(StateFile, Log.Write) is { } text ? JsonSerializer.Deserialize<State>(text) ?? new() : new();
        }
        catch (Exception ex)
        {
            Log.Write($"Startup guard: guard.json could not be read, starting its count over: {ex.Message}");
            return new();
        }
    }

    // Throws when it could not be written; every caller catches.
    static void Save(State s) => AtomicFile.Write(StateFile, JsonSerializer.Serialize(s));
}
