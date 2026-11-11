using System.IO;
using System.Text;

namespace Ventisol.Station;

// The one way this app writes a file it must be able to read back: beside the file, flushed to the
// disk, then moved into place. A power cut or a crash halfway leaves the old file or the new one,
// never half a file. Every store on this PC goes through here.
static class AtomicFile
{
    // Throws when the file could not be written.
    public static void Write(string path, byte[] bytes)
    {
        if (Path.GetDirectoryName(path) is { Length: > 0 } folder) Directory.CreateDirectory(folder);
        var temp = path + ".tmp";
        using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            stream.Write(bytes);
            // Past Windows' cache and onto the disk, or the move could put an empty file in place.
            stream.Flush(flushToDisk: true);
        }
        File.Move(temp, path, overwrite: true);
    }

    public static void Write(string path, string text) => Write(path, Encoding.UTF8.GetBytes(text));

    // False, and one log line naming the file, when it could not be written.
    public static bool TryWrite(string path, byte[] bytes, Action<string> log)
    {
        try { Write(path, bytes); return true; }
        catch (Exception e)
        {
            log($"{Path.GetFileName(path)} not saved: {e.Message}");
            return false;
        }
    }

    public static bool TryWrite(string path, string text, Action<string> log) => TryWrite(path, Encoding.UTF8.GetBytes(text), log);

    // The file's text, or null when there is none. A file that is there but can't be read is logged:
    // the caller then starts from its defaults, and the log says why.
    public static string? TryRead(string path, Action<string> log)
    {
        try { return File.ReadAllText(path); }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException) { return null; }
        catch (Exception e)
        {
            log($"{Path.GetFileName(path)} could not be read: {e.Message}");
            return null;
        }
    }
}
