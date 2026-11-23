using Microsoft.Win32;

namespace Ventisol.Station.Updates;

// Starts the app in kiosk mode when this Windows user logs in. Set by the installer, removed by the uninstaller.
// Per user (HKCU), so it needs no admin rights and follows the auto-login user on the station PC.
// The same entry makes every other start of the installed app a kiosk too (IsKiosk): the first one
// after the install, a restart, the start after an update. Take --kiosk out of the entry (the setup
// screen's Kiosk choice does that, SetKiosk), or the entry away, and the app is a plain window again.
static class Autostart
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "VentisolStation";
    const string KioskArg = "--kiosk";

    public static void Enable()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            // current\ keeps its path across updates: Velopack swaps what is inside it.
            var exe = Environment.ProcessPath!;
            key.SetValue(Name, $"\"{exe}\" {KioskArg}");
            Log.Write($"Autostart set: {exe} {KioskArg}");
        }
        catch (Exception ex) { Log.Write($"Autostart not set: {ex.Message}"); } // Must not fail the install.
    }

    // True when this very exe is the one Windows starts as a kiosk at login. A developer's build is
    // another exe, so it stays a window whatever is installed on the PC.
    public static bool IsKiosk() =>
        OwnCommand() is { } command && command.Contains(KioskArg, StringComparison.OrdinalIgnoreCase);

    // True when Windows starts this very exe at login: then kiosk mode is this app's to turn on and
    // off (SetKiosk). A developer's build never owns the entry, so it can't take the PC's autostart.
    public static bool OwnsEntry() => OwnCommand() is not null;

    // The setup screen's kiosk choice: the entry keeps starting this exe at login, with or without
    // --kiosk. The next start follows it. False when the entry is not this exe's, or can't be written.
    public static bool SetKiosk(bool on)
    {
        try
        {
            if (!OwnsEntry()) return false;
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            var exe = Environment.ProcessPath!;
            key.SetValue(Name, on ? $"\"{exe}\" {KioskArg}" : $"\"{exe}\"");
            Log.Write($"Autostart set: {exe} {(on ? KioskArg : "(window)")}");
            return true;
        }
        catch (Exception ex) { Log.Write($"Kiosk mode not changed: {ex.Message}"); return false; }
    }

    // The entry's command, when it starts this very exe; else null.
    static string? OwnCommand()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(Name) is string command
                   && Environment.ProcessPath is { Length: > 0 } exe
                   && command.Contains($"\"{exe}\"", StringComparison.OrdinalIgnoreCase)
                ? command : null;
        }
        catch { return null; }
    }

    public static void Disable()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            key?.DeleteValue(Name, throwOnMissingValue: false);
        }
        catch (Exception ex) { Log.Write($"Autostart not removed: {ex.Message}"); }
    }
}
