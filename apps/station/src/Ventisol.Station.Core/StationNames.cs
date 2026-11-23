using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.Core;

// A station's name comes from its machine in OptiPeople, so every screen calls it the same.
// The name kept on this PC is what is shown until OptiPeople has been read, and whenever it can't be.
public static class StationNames
{
    // The stations whose machine is called something else in OptiPeople, by number, with that name.
    // A station without a machine, or whose machine isn't on the account or has no name, keeps its own.
    public static IReadOnlyDictionary<int, string> Renamed(IEnumerable<StationSetup> stations, IEnumerable<(Guid Id, string Name)> machines)
    {
        var names = new Dictionary<Guid, string>();
        foreach (var (id, name) in machines)
            if (!string.IsNullOrWhiteSpace(name)) names[id] = name.Trim();

        var renamed = new Dictionary<int, string>();
        foreach (var s in stations)
            if (s.MachineId is { } id && names.TryGetValue(id, out var name) && name != s.Name)
                renamed[s.Number] = name;
        return renamed;
    }

    // Which machine each station scans to, by station number, from the scans: the newest scan with a
    // machine wins. A viewer is often set up without machines; the scan PC's scans say what they are.
    public static Dictionary<int, Guid> Links(IEnumerable<ScanEvent> scans)
    {
        var links = new Dictionary<int, Guid>();
        foreach (var e in scans.Where(e => e.MachineId is not null).OrderBy(e => e.At)) links[e.StationNo] = e.MachineId!.Value;
        return links;
    }

    // The stations with a machine from the links where they have none set up themselves.
    public static IEnumerable<StationSetup> Linked(IEnumerable<StationSetup> stations, IReadOnlyDictionary<int, Guid> links) =>
        stations.Select(s => s.MachineId is null && links.TryGetValue(s.Number, out var m) ? s with { MachineId = m } : s);

    // The settings with those names, everything else as it was.
    public static StationSettings Apply(StationSettings settings, IReadOnlyDictionary<int, string> renamed) =>
        renamed.Count == 0 ? settings : settings with
        {
            Stations = [.. settings.Stations.Select(s => renamed.TryGetValue(s.Number, out var name) ? s with { Name = name } : s)],
        };
}
