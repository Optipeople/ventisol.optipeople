using System.IO;
using System.Security.Cryptography;
using System.Text;
using Ventisol.Station.Core;

namespace Ventisol.Station;

// What the setup screen sets, kept on this PC next to the layout. Never throws: with nothing saved,
// or a file that can't be read, the app starts from StationSettings.Default.
// The API password is kept apart, encrypted with DPAPI for this Windows user, so only this user on
// this PC can read it back. It is never written as plain text, and never logged.
static class SettingsStore
{
    static readonly string Folder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Ventisol", "Station");

    static readonly string SettingsFile = Path.Combine(Folder, "settings.json");
    static readonly string PasswordFile = Path.Combine(Folder, "password.bin");

    // Ties the encrypted password to this app, so another program for the same user can't just ask DPAPI for it.
    static readonly byte[] Entropy = "Ventisol.Station/opticloud-password/v1"u8.ToArray();

    public static StationSettings Load()
    {
        try { return StationSettingsJson.Deserialize(File.ReadAllText(SettingsFile)) ?? StationSettings.Default; }
        catch { return StationSettings.Default; } // None saved yet, or unreadable.
    }

    // False when it could not be written; the settings in memory still hold until the app restarts.
    public static bool Save(StationSettings settings) =>
        WriteAtomic(SettingsFile, Encoding.UTF8.GetBytes(StationSettingsJson.Serialize(settings)));

    public static bool HasPassword => File.Exists(PasswordFile);

    public static string? LoadPassword()
    {
        byte[]? plain = null;
        try
        {
            plain = ProtectedData.Unprotect(File.ReadAllBytes(PasswordFile), Entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch { return null; } // None saved, or saved by another Windows user or PC.
        finally { if (plain is not null) CryptographicOperations.ZeroMemory(plain); }
    }

    public static bool SavePassword(string password)
    {
        if (string.IsNullOrEmpty(password)) return ClearPassword();
        var plain = Encoding.UTF8.GetBytes(password);
        try { return WriteAtomic(PasswordFile, ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser)); }
        catch { return false; }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }

    public static bool ClearPassword()
    {
        try { File.Delete(PasswordFile); return true; }
        catch { return false; }
    }

    // Write beside the file and move it into place, so a crash halfway never leaves half a file.
    static bool WriteAtomic(string path, byte[] bytes)
    {
        try
        {
            Directory.CreateDirectory(Folder);
            var temp = path + ".tmp";
            File.WriteAllBytes(temp, bytes);
            File.Move(temp, path, overwrite: true);
            return true;
        }
        catch { return false; }
    }
}
