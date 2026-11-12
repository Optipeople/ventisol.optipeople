using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Ventisol.Station.Core;

namespace Ventisol.Station.Scanning;

// A cradle in CDC mode as Windows sees it: a USB device with a COM port.
// Id is the USB port it is plugged into ("usb:" + location path, see UsbPort), which stays the same
// when Windows renumbers COM ports, and tells cradles apart although they all report the same
// serial number in CDC mode. Only if Windows has no location path is it the USB serial number.
public sealed record Cradle(string Id, string PortName, bool IsZebra, string Name);

public static partial class CradleFinder
{
    // The Ports device class: every COM port, USB or not.
    const string PortsClass = "{4d36e978-e325-11ce-bfc1-08002be10318}";

    // Devices already logged as having no location path, so it is said once, not every poll.
    static readonly HashSet<string> NoLocationLogged = new(StringComparer.OrdinalIgnoreCase);

    // Devices already logged as read without being a Zebra, so it is said once, not every poll.
    static readonly HashSet<string> FallbackLogged = new(StringComparer.OrdinalIgnoreCase);

    // The USB serial devices present now. Zebra cradles only (USB vendor id 05E0), if there is at
    // least one; otherwise any USB serial device, so a cradle that reports another vendor id, or
    // another scanner on a dev PC, still works. That fallback is logged, naming the device.
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
                all.Add(new Cradle(IdOf(pnpId!, usb, log), com.Groups[1].Value, usb.IsZebra, name));
            }
        }
        if (all.Any(c => c.IsZebra)) return all.Where(c => c.IsZebra).ToList();
        foreach (var cradle in all)
            lock (FallbackLogged)
                if (FallbackLogged.Add(cradle.Id + "|" + cradle.PortName))
                    log?.Invoke($"No Zebra cradle found: reading {cradle.Name} ({cradle.Id}) as a scanner.");
        return all;
    }

    static string IdOf(string pnpId, UsbDeviceId usb, Action<string>? log)
    {
        // A composite device puts the COM port on an interface; the port is the parent's.
        var parentId = usb.IsInterface ? ParentOf(pnpId) : null;
        if (LocationOf(parentId ?? pnpId) is { } path) return UsbPort.IdOf(path);

        lock (NoLocationLogged)
            if (NoLocationLogged.Add(pnpId))
                log?.Invoke($"{pnpId} has no USB location path; it is known by its USB serial number instead.");
        return SerialOf(pnpId, usb, parentId);
    }

    static string SerialOf(string pnpId, UsbDeviceId usb, string? parentId)
    {
        if (usb.HasSerial) return usb.Instance;
        if (UsbDeviceId.TryParse(parentId, out var parent) && parent.HasSerial) return parent.Instance;
        // No serial number: the instance id is still stable while it stays in the same USB port.
        return pnpId;
    }

    static string? ParentOf(string instanceId)
    {
        if (CM_Locate_DevNodeW(out var node, instanceId, 0) != 0) return null;
        if (CM_Get_Parent(out var parent, node, 0) != 0) return null;
        var buffer = new char[400];
        return CM_Get_Device_IDW(parent, buffer, buffer.Length, 0) == 0 ? new string(buffer).TrimEnd('\0') : null;
    }

    // DEVPKEY_Device_LocationPaths of a device, e.g. PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(7)#USB(4).
    static string? LocationOf(string instanceId)
    {
        try
        {
            if (CM_Locate_DevNodeW(out var node, instanceId, 0) != 0) return null;
            var key = LocationPathsKey;
            uint size = 0;
            var cr = CM_Get_DevNode_PropertyW(node, ref key, out _, null, ref size, 0);
            if (cr != CR_BUFFER_SMALL || size == 0) return null;
            var buffer = new byte[size];
            if (CM_Get_DevNode_PropertyW(node, ref key, out var type, buffer, ref size, 0) != 0) return null;
            if (type != DEVPROP_TYPE_STRING_LIST && type != DEVPROP_TYPE_STRING) return null;
            var paths = Encoding.Unicode.GetString(buffer, 0, (int)size).Split('\0');
            return UsbPort.PickLocationPath(paths);
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
        {
            return null;
        }
    }

    [GeneratedRegex(@"\((COM\d+)\)", RegexOptions.IgnoreCase)]
    private static partial Regex ComName();

    const int CR_BUFFER_SMALL = 0x1A;
    const uint DEVPROP_TYPE_STRING = 0x12;
    const uint DEVPROP_TYPE_STRING_LIST = 0x2012;

    static readonly DevPropKey LocationPathsKey = new(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 37);

    [StructLayout(LayoutKind.Sequential)]
    struct DevPropKey(Guid fmtid, uint pid)
    {
        public Guid Fmtid = fmtid;
        public uint Pid = pid;
    }

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Locate_DevNodeW(out uint devInst, string deviceId, uint flags);

    [DllImport("cfgmgr32.dll")]
    static extern int CM_Get_Parent(out uint parent, uint devInst, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_Device_IDW(uint devInst, [Out] char[] buffer, int length, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_DevNode_PropertyW(uint devInst, ref DevPropKey key, out uint type, [Out] byte[]? buffer, ref uint size, uint flags);
}
