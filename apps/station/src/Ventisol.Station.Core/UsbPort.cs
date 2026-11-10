using System.Text.RegularExpressions;

namespace Ventisol.Station.Core;

// A cradle is known by the USB port it is plugged into, not by its USB serial number: in CDC mode
// every LI3678 cradle reports the same serial (USB_CDC_SYMBOL_SCANNER). Windows gives each USB device
// a location path, e.g. PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(7)#USB(4): root port 7, then port 4 on
// the hub behind it. The scanner id is "usb:" plus that path, so a spare cradle plugged into the
// same port takes over that station.
public static partial class UsbPort
{
    public const string IdPrefix = "usb:";

    // Of the paths Windows lists for a device (DEVPKEY_Device_LocationPaths), the PCI one through
    // the USB root hub. The ACPI one that often comes with it names the same port less plainly.
    public static string? PickLocationPath(IEnumerable<string?>? paths)
    {
        var all = (paths ?? []).Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => p!.Trim()).ToList();
        return all.FirstOrDefault(p => p.Contains("#USBROOT(", StringComparison.OrdinalIgnoreCase) && !IsInterface(p))
            ?? all.FirstOrDefault(p => !IsInterface(p));
    }

    public static string IdOf(string locationPath) => IdPrefix + locationPath.Trim();

    public static bool IsPortId(string? scannerId) =>
        scannerId is not null && scannerId.StartsWith(IdPrefix, StringComparison.OrdinalIgnoreCase);

    // The port numbers after the root hub, e.g. "7.4" for ...#USBROOT(0)#USB(7)#USB(4). Null if the
    // id is not a port id or holds no USB port.
    public static string? PortNumbers(string? scannerId)
    {
        if (!IsPortId(scannerId)) return null;
        var path = scannerId![IdPrefix.Length..];
        var root = path.IndexOf("USBROOT(", StringComparison.OrdinalIgnoreCase);
        var numbers = UsbSegment().Matches(root < 0 ? path : path[root..]).Select(m => m.Groups[1].Value).ToList();
        return numbers.Count == 0 ? null : string.Join('.', numbers);
    }

    // What the setup screen shows for a scanner: "USB-port 7.4 (COM5)", or the id itself when it
    // is not a port id (an old saved serial number).
    public static string Label(string scannerId, string? comPort = null)
    {
        var label = PortNumbers(scannerId) is { } numbers ? $"USB-port {numbers}"
            : IsPortId(scannerId) ? scannerId[IdPrefix.Length..]
            : scannerId;
        return string.IsNullOrWhiteSpace(comPort) ? label : $"{label} ({comPort.Trim()})";
    }

    // One interface of a composite device; its path ends in USBMI(n) and is not the device's port.
    static bool IsInterface(string path) => path.Contains("#USBMI(", StringComparison.OrdinalIgnoreCase);

    [GeneratedRegex(@"#USB\((\d+)\)", RegexOptions.IgnoreCase)]
    private static partial Regex UsbSegment();
}
