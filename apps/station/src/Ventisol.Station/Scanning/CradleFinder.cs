using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Ventisol.Station.Core;

namespace Ventisol.Station.Scanning;

// A cradle in CDC mode as Windows sees it: a USB device with a COM port.
// Id is its USB serial number, which stays the same when Windows renumbers COM ports.
public sealed record Cradle(string Id, string PortName, bool IsZebra, string Name);

public static partial class CradleFinder
{
    // The Ports device class: every COM port, USB or not.
    const string PortsClass = "{4d36e978-e325-11ce-bfc1-08002be10318}";

    // The USB serial devices present now. Zebra cradles only, if there is at least one;
    // otherwise any USB serial device, so another scanner works on a dev PC.
    public static IReadOnlyList<Cradle> Find(Action<string>? log = null)
    {
        var all = new List<Cradle>();
        using var searcher = new ManagementObjectSearcher(
            $"SELECT Name, PNPDeviceID FROM Win32_PnPEntity WHERE ClassGuid = '{PortsClass}'");
        using var results = searcher.Get();
        foreach (var device in results)
        {
            using (device)
            {
                var name = device["Name"] as string ?? "";
                var pnpId = device["PNPDeviceID"] as string;
                if (ComName().Match(name) is not { Success: true } com) continue;
                if (!UsbDeviceId.TryParse(pnpId, out var usb)) continue;
                all.Add(new Cradle(SerialOf(pnpId!, usb, log), com.Groups[1].Value, usb.IsZebra, name));
            }
        }
        return all.Any(c => c.IsZebra) ? all.Where(c => c.IsZebra).ToList() : all;
    }

    static string SerialOf(string pnpId, UsbDeviceId usb, Action<string>? log)
    {
        if (usb.HasSerial) return usb.Instance;

        // A composite device puts the COM port on an interface; the serial is on its parent.
        if (usb.IsInterface && ParentOf(pnpId) is { } parentId
            && UsbDeviceId.TryParse(parentId, out var parent) && parent.HasSerial)
            return parent.Instance;

        // No serial number: the instance id is still stable while it stays in the same USB port.
        log?.Invoke($"{pnpId} has no USB serial number; it is known by its USB port instead.");
        return pnpId;
    }

    static string? ParentOf(string instanceId)
    {
        if (CM_Locate_DevNodeW(out var node, instanceId, 0) != 0) return null;
        if (CM_Get_Parent(out var parent, node, 0) != 0) return null;
        var buffer = new char[400];
        return CM_Get_Device_IDW(parent, buffer, buffer.Length, 0) == 0 ? new string(buffer).TrimEnd('\0') : null;
    }

    [GeneratedRegex(@"\((COM\d+)\)", RegexOptions.IgnoreCase)]
    private static partial Regex ComName();

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Locate_DevNodeW(out uint devInst, string deviceId, uint flags);

    [DllImport("cfgmgr32.dll")]
    static extern int CM_Get_Parent(out uint parent, uint devInst, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_Device_IDW(uint devInst, [Out] char[] buffer, int length, uint flags);
}
