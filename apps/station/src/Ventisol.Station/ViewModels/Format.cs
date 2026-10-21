namespace Ventisol.Station.ViewModels;

static class Format
{
    // 04:09, or 1:04:09 once it passes an hour.
    public static string Duration(TimeSpan t) =>
        t.TotalHours >= 1 ? $"{(int)t.TotalHours}:{t:mm':'ss}" : t.ToString("mm':'ss");

    // For totals in a table: 41 min, 1 t 18 min.
    public static string Long(TimeSpan t) =>
        t < TimeSpan.FromMinutes(1) ? "under 1 min"
        : t.TotalHours >= 1 ? $"{(int)t.TotalHours} t {t.Minutes} min"
        : $"{(int)t.TotalMinutes} min";
}
