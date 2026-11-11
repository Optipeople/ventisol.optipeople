namespace Ventisol.Station.Core.Cloud;

// What went wrong on a side (reading or sending). Network: try again, it passes. Auth: the login or
// the user's access, a person must fix the setup. Unexpected: a bug or an answer not understood.
public enum CloudProblem { None, Network, Auth, Unexpected }

// What CloudSync knows, for CloudHealth to judge. Times are the PC's clock (now in Evaluate),
// except OrdersFailingFor, a duration. LastRead: OptiCloud last read (or logged in to) without fault.
// LastSent: a scan last got in. OldestWaiting: scan time of the oldest scan not sent yet.
// ReadFailing: the last read or login failed. Fatal: the link stopped for good (a bug).
public sealed record CloudFacts(
    StationMode Mode,
    bool IsSetUp,
    DateTimeOffset StartedAt,
    string Account = "",
    int Pending = 0,
    DateTimeOffset? OldestWaiting = null,
    int Refused = 0,
    DateTimeOffset? LastRead = null,
    DateTimeOffset? LastSent = null,
    bool ReadFailing = false,
    CloudProblem ReadProblem = CloudProblem.None,
    string ReadError = "",
    CloudProblem WriteProblem = CloudProblem.None,
    string WriteError = "",
    string? Fatal = null,
    TimeSpan? OrdersFailingFor = null,
    TimeSpan? ClockSkew = null);

// The rules for the OptiCloud dot and text. Outages are expected to be minutes long and scans
// wait safely on disk meanwhile, so a scan station judges by how long its oldest scan has waited,
// not by the last call: green while nothing has waited longer than Patience (and nothing was
// refused), amber when a scan has, red only for what needs a person (the login or the user's
// access, refused scans, a fault not expected). A viewer is amber as soon as a read fails: it is
// there to show what OptiCloud holds.
public static class CloudHealth
{
    // How long a scan may wait, or the link be gone, before the station says so.
    public static readonly TimeSpan Patience = TimeSpan.FromSeconds(60);

    // How long a viewer shows its last data as current when reads fail.
    public static readonly TimeSpan ViewerPatience = TimeSpan.FromSeconds(30);

    // A PC clock this far off OptiCloud's is said, scan times come from it.
    public static readonly TimeSpan ClockTolerance = TimeSpan.FromSeconds(60);

    public static CloudStatus Evaluate(CloudFacts f, DateTimeOffset now)
    {
        var n = f.Pending;
        var waiting = n == 0 ? null : n == 1 ? "1 scanning venter" : $"{n} scanninger venter";
        var lastContact = Latest(f.LastRead, f.LastSent);
        var sent = n > 0 && f.LastSent is { } s ? $"sidst sendt {s.ToLocalTime():HH':'mm}" : null;

        if (!f.IsSetUp) return new CloudStatus(CloudState.NotSetUp, Join("Ikke sat op", waiting), n, lastContact, f.Refused, LastRead: f.LastRead);

        var warnings = new List<string>();
        if (f.OrdersFailingFor is { } o && o > Patience) warnings.Add("Ordre til maskine ikke sendt");
        if (ClockText(f.ClockSkew) is { } clock) warnings.Add(clock);

        CloudState state;
        string head;
        string? banner = null;
        if (Alarm(f) is { } alarm)
        {
            state = CloudState.Error;
            head = alarm;
        }
        else
        {
            var waitedLong = f.OldestWaiting is { } oldest && now - oldest > Patience;
            // Gone for longer than the patience: no answer at all since then (or since the start).
            var goneLong = f.ReadFailing && now - (lastContact ?? f.StartedAt) > Patience;
            var offline = f.Mode == StationMode.Viewer ? f.ReadFailing : waitedLong || goneLong;
            if (offline)
            {
                state = CloudState.Offline;
                // Reads work but the scans don't go: say that, not "no connection".
                var noLink = f.ReadFailing || f.Mode == StationMode.Viewer;
                head = noLink ? "Offline" : "Sender ikke";
                if (f.Mode == StationMode.Scan) banner = Banner(noLink, n);
            }
            else if (lastContact is null)
            {
                state = CloudState.Connecting;
                head = "Forbinder…";
            }
            else if (warnings.Count > 0)
            {
                state = CloudState.Warning;
                head = f.Account.Length > 0 ? $"Forbundet · {f.Account}" : "Forbundet";
            }
            else
            {
                state = CloudState.Online;
                head = f.Account.Length > 0 ? $"Forbundet · {f.Account}" : "Forbundet";
            }
        }

        var parts = new List<string?> { head };
        parts.AddRange(warnings);
        parts.Add(waiting);
        // The time only says something when scans wait and one has been sent before.
        if (state != CloudState.Online) parts.Add(sent);
        return new CloudStatus(state, Join([.. parts]), n, lastContact, f.Refused, banner, f.LastRead);
    }

    // What needs a person, else null.
    static string? Alarm(CloudFacts f)
    {
        if (f.Fatal is { } fatal) return $"Fejl: {fatal}";
        if (f.WriteProblem is CloudProblem.Auth or CloudProblem.Unexpected) return $"Fejl: {f.WriteError}";
        if (f.ReadProblem is CloudProblem.Auth or CloudProblem.Unexpected) return $"Fejl: {f.ReadError}";
        if (f.Refused > 0) return f.Refused == 1 ? "1 scanning afvist, se log" : $"{f.Refused} scanninger afvist, se log";
        return null;
    }

    static string Banner(bool noLink, int pending) =>
        (noLink ? "Ingen forbindelse til OptiCloud." : "Scanninger kan ikke sendes til OptiCloud lige nu.") +
        $" Scanninger gemmes på PC'en og sendes automatisk ({pending} venter). Fortsæt som normalt.";

    // "PC'ens ur går 3 min forkert" when the PC's clock is off OptiCloud's by more than the tolerance.
    public static string? ClockText(TimeSpan? skew)
    {
        if (skew is not { } d || d.Duration() <= ClockTolerance) return null;
        var minutes = (int)Math.Round(d.Duration().TotalMinutes, MidpointRounding.AwayFromZero);
        return $"PC'ens ur går {minutes} min forkert";
    }

    // A viewer's data is stale when it has not read OptiCloud for ViewerPatience while reads fail.
    public static bool IsStale(CloudStatus status, DateTimeOffset now) =>
        status.State is CloudState.Offline or CloudState.Error && (status.LastRead is not { } read || now - read > ViewerPatience);

    // The bar over a viewer's tiles when its data is stale, else null. Never read: nothing to date.
    public static string? StaleText(CloudStatus status, DateTimeOffset now) =>
        !IsStale(status, now) ? null
        : status.LastRead is { } read ? $"Data fra {read.ToLocalTime():HH':'mm} · ingen forbindelse til OptiCloud"
        : "Ingen forbindelse til OptiCloud";

    // What a free station says. A viewer shows scans from OptiCloud, so until it has read once it
    // waits for OptiCloud, not for a scan; a scan station asks for one.
    public static string IdleText(StationMode mode, bool hasRead) =>
        mode == StationMode.Scan ? "Scan et element" : hasRead ? "Venter på scanning" : "Venter på OptiCloud…";

    // The report's note when it may miss scans, else null. Viewer: stale data. Scan station: its
    // own scans count, the other PCs' only as far as they were read.
    public static string? ReportNote(StationMode mode, CloudStatus status, DateTimeOffset now)
    {
        if (status.State == CloudState.NotSetUp) return null;
        if (mode == StationMode.Viewer)
            return StaleText(status, now) is null ? null
                : status.LastRead is { } r ? $"Kan mangle scanninger: data fra {r.ToLocalTime():HH':'mm}" : "Kan mangle scanninger: OptiCloud ikke læst endnu";
        if (status.State != CloudState.Offline) return null;
        return status.LastRead is { } read ? $"Kun denne PC's scanninger siden {read.ToLocalTime():HH':'mm}" : "Kun denne PC's scanninger";
    }

    static DateTimeOffset? Latest(DateTimeOffset? a, DateTimeOffset? b) => a is null ? b : b is null ? a : a > b ? a : b;

    static string Join(params string?[] parts) => string.Join(" · ", parts.Where(p => !string.IsNullOrEmpty(p)));
}
