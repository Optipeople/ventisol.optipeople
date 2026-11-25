using Ventisol.Station.Core;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

// Stands in for the 7 scanners until the COM port reader is in. Makes up label
// barcodes: a new element when the station is free, the same one again to scan it out
// (at a station with "Max i gang" above 1, see Scan).
// It ignores a scanner that is switched off, like a real one would be silent.
sealed class DemoScanner(MainViewModel vm)
{
    int _seq;

    public void Scan(int scannerNumber, bool otherElement = false)
    {
        var station = vm.Stations.FirstOrDefault(s => s.Number == scannerNumber);
        if (station is not { ScannerConnected: true }) return;

        // A station with several at once: a new element beside the others until it is full, then the
        // oldest out. otherElement always tries a new one, so the refusal can be seen.
        var code = station.IsMulti
            ? !otherElement && station.State.IsFull ? station.State.Active[0].Barcode.Raw : NextCode(station.Has)
            : station.Current is { } current && !otherElement ? current.Raw : NextCode();
        vm.Scan(scannerNumber, code, DateTimeOffset.Now);
    }

    public void ToggleScanner(int scannerNumber)
    {
        if (vm.Stations.FirstOrDefault(s => s.Number == scannerNumber) is { } station)
            station.ScannerConnected = !station.ScannerConnected;
    }

    // A screen in use, for screenshots and showing Ventisol: some stations working
    // for a while, one scanner missing, one scan just in and one just rejected.
    public void Showcase(DateTimeOffset now)
    {
        // The morning so far: finished elements, so the report has something to show.
        (int scanner, string code, int from, int to)[] morning =
        [
            (1, "058555010101", -190, -172), (2, "058555010101", -168, -151), (5, "058555010101", -149, -118),
            (1, "058555010102", -171, -150), (2, "058555010102", -150, -136), (5, "058555010102", -117, -90),
            (7, "058555010101", -88, -80), (7, "058555010102", -79, -71),
            (1, "058556040101", -140, -121), (2, "058556040101", -118, -99), (6, "058556040101", -97, -60),
            (1, "058556050101", -120, -104), (2, "058556050101", -98, -83), (5, "058556050101", -82, -41),
            (1, "058556050102", -100, -81), (4, "058556050102", -80, -66), (6, "058556050102", -58, -29),
            (1, "058557010101", -60, -44), (2, "058557010101", -43, -30), (4, "058558010101", -64, -45),
            (4, "058558020101", -44, -20), (1, "058556050103", -12, -12),
        ];
        foreach (var (n, code, from, to) in morning.Where(m => m.from != m.to))
        {
            vm.Scan(n, code, now.AddMinutes(from));
            vm.Scan(n, code, now.AddMinutes(to));
        }

        vm.Scan(1, "058556050103", now.AddMinutes(-12).AddSeconds(-41));
        vm.Scan(2, "058557020102", now.AddMinutes(-3).AddSeconds(-8));
        vm.Scan(5, "058559040101", now.AddMinutes(-27).AddSeconds(-15));
        vm.Scan(7, "058556010101", now.AddMinutes(-1).AddSeconds(-52));
        vm.Stations[2].ScannerConnected = false;
        vm.Scan(2, "058557030101", now);
        vm.Scan(6, "058558030102", now);
    }

    // For Alt+V in a dev build: a shift that ends at now, as a demo of the stop at shift end. It began
    // an hour before, so an element scanned in before Alt+V counts down from the shift end, and one
    // scanned in after it is overtime.
    public static ShiftSchedule ShiftEndingNow(DateTimeOffset now)
    {
        var end = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.Local).DateTime;
        var start = end.AddHours(-1);
        return new ShiftSchedule([new ShiftBlock(start.DayOfWeek, TimeOnly.FromDateTime(start), TimeOnly.FromDateTime(end))], []);
    }

    // One that is not in progress at the station, as long as there is one among the codes made up.
    string NextCode(Func<string, bool> taken)
    {
        var code = NextCode();
        for (var i = 0; i < 12 && taken(code); i++) code = NextCode();
        return code;
    }

    string NextCode()
    {
        _seq++;
        var order = 58556 + _seq % 4;
        var position = 1 + _seq % 6;
        var piece = 1 + _seq % 3;
        return $"0{order:D5}{position:D2}01{piece:D2}";
    }
}
