using System.IO;
using System.Security.Cryptography;
using System.Text;
using Ventisol.Station.Core;

namespace Ventisol.Station;

// What the setup screen sets, kept on this PC next to the layout. Never throws: with nothing saved,
// or a file that can't be read, the app starts from StationSettings.Default, and the log says so.
// The API password is kept apart, encrypted with DPAPI for this Windows user, so only this user on
// this PC can read it back. It is never written as plain text, and never logged.
static class SettingsStore
{
    static readonly string Folder = AppPaths.Data;

    static readonly string SettingsFile = Path.Combine(Folder, "settings.json");
    static readonly string PasswordFile = Path.Combine(Folder, "password.bin");

    // Ties the encrypted password to this app, so another program for the same user can't just ask DPAPI for it.
    static readonly byte[] Entropy = "Ventisol.Station/opticloud-password/v1"u8.ToArray();

    public static StationSettings Load()
    {
        // None saved yet: the defaults, and nothing to say.
        if (AtomicFile.TryRead(SettingsFile, Log.Write) is not { } text) return StationSettings.Default;
        try
        {
            if (StationSettingsJson.Deserialize(text) is { } settings) return settings;
            Log.Write("settings.json holds no settings: starting from the defaults, with OptiCloud not set up");
        }
        catch (Exception e) { Log.Write($"settings.json could not be read: starting from the defaults, with OptiCloud not set up: {e.Message}"); }
        return StationSettings.Default;
    }

    // False when it could not be written; the settings in memory still hold until the app restarts.
    public static bool Save(StationSettings settings) =>
        AtomicFile.TryWrite(SettingsFile, StationSettingsJson.Serialize(settings), Log.Write);

    public static bool HasPassword => File.Exists(PasswordFile);

    public static string? LoadPassword()
    {
        byte[]? plain = null;
        try
        {
            plain = ProtectedData.Unprotect(File.ReadAllBytes(PasswordFile), Entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException) { return null; } // None saved.
        catch (Exception e)
        {
            // Saved by another Windows user or on another PC, or damaged. The message never holds the password.
            Log.Write($"The saved OptiCloud password could not be read, it must be typed again in the setup: {e.Message}");
            return null;
        }
        finally { if (plain is not null) CryptographicOperations.ZeroMemory(plain); }
    }

    public static bool SavePassword(string password)
    {
        if (string.IsNullOrEmpty(password)) return ClearPassword();
        var plain = Encoding.UTF8.GetBytes(password);
        try { return AtomicFile.TryWrite(PasswordFile, ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser), Log.Write); }
        catch (Exception e)
        {
            Log.Write($"The OptiCloud password could not be saved: {e.Message}");
            return false;
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }

    public static bool ClearPassword()
    {
        try { File.Delete(PasswordFile); return true; }
        catch (Exception e)
        {
            Log.Write($"The saved OptiCloud password could not be removed: {e.Message}");
            return false;
        }
    }
}
