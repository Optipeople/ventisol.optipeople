using Microsoft.Win32;

namespace Ventisol.Station.Updates;

// Starts the app in kiosk mode when this Windows user logs in. Set by the installer, removed by the uninstaller.
// Per user (HKCU), so it needs no admin rights and follows the auto-login user on the station PC.
static class Autostart
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "VentisolStation";

    public static void Enable()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            // current\ keeps its path across updates: Velopack swaps what is inside it.
            var exe = Environment.ProcessPath!;
            key.SetValue(Name, $"\"{exe}\" --kiosk");
            Log.Write($"Autostart set: {exe} --kiosk");
        }
        catch (Exception ex) { Log.Write($"Autostart not set: {ex.Message}"); } // Must not fail the install.
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
