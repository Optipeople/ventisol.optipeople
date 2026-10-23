using System.Diagnostics.CodeAnalysis;
using System.Text.RegularExpressions;

namespace Ventisol.Station.Core;

// A Windows USB device instance id, e.g. USB\VID_05E0&PID_1701\S20123456789.
// The last part is the device's USB serial number, unless Windows made it up (it then holds '&',
// like 6&2a1b3c4d&0&2) or this is one interface of a composite device (MI_xx in the middle part).
public sealed partial record UsbDeviceId(string Vid, string Pid, string Instance, bool IsInterface)
{
    public const string ZebraVid = "05E0";

    public bool IsZebra => Vid == ZebraVid;
    public bool HasSerial => !IsInterface && !Instance.Contains('&');

    public static bool TryParse(string? pnpDeviceId, [NotNullWhen(true)] out UsbDeviceId? id)
    {
        id = null;
        var m = Pattern().Match(pnpDeviceId ?? "");
        if (!m.Success) return false;
        id = new UsbDeviceId(
            m.Groups["vid"].Value.ToUpperInvariant(),
            m.Groups["pid"].Value.ToUpperInvariant(),
            m.Groups["inst"].Value,
            m.Groups["mi"].Success);
        return true;
    }

    [GeneratedRegex(@"^USB\\VID_(?<vid>[0-9A-F]{4})&PID_(?<pid>[0-9A-F]{4})(?<mi>&MI_[0-9A-F]{2})?[^\\]*\\(?<inst>[^\\]+)$", RegexOptions.IgnoreCase)]
    private static partial Regex Pattern();
}
