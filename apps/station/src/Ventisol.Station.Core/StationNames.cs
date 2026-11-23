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

    // The settings with those names, everything else as it was.
    public static StationSettings Apply(StationSettings settings, IReadOnlyDictionary<int, string> renamed) =>
        renamed.Count == 0 ? settings : settings with
        {
            Stations = [.. settings.Stations.Select(s => renamed.TryGetValue(s.Number, out var name) ? s with { Name = name } : s)],
        };
}
