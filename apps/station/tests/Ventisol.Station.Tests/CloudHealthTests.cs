using System.Net;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.Tests;

public class CloudHealthTests
{
    static readonly DateTimeOffset Now = new(DateTime.Today.AddHours(12));

    // A scan station that has been connected for a while, nothing wrong.
    static CloudFacts Station(int pending = 0, TimeSpan? oldest = null) => new(
        StationMode.Scan, IsSetUp: true, StartedAt: Now.AddHours(-1), Account: "Ventisol",
        Pending: pending, OldestWaiting: oldest is { } o ? Now - o : null,
        LastRead: Now.AddSeconds(-3), LastSent: Now.AddMinutes(-5));

    static CloudStatus Judge(CloudFacts f) => CloudHealth.Evaluate(f, Now);

    [Fact]
    public void All_well_is_green_and_names_the_account()
    {
        var s = Judge(Station());

        Assert.Equal(CloudState.Online, s.State);
        Assert.Equal("Forbundet · Ventisol", s.Text);
        Assert.Null(s.Banner);
    }

    [Fact]
    public void A_scan_waiting_less_than_a_minute_is_still_green_but_is_counted()
    {
        var s = Judge(Station(pending: 2, oldest: TimeSpan.FromSeconds(59)));

        Assert.Equal(CloudState.Online, s.State);
        Assert.Equal("Forbundet · Ventisol · 2 scanninger venter", s.Text);
        Assert.Null(s.Banner);
    }

    [Fact]
    public void A_scan_waiting_more_than_a_minute_without_a_connection_is_amber_with_the_banner()
    {
        var s = Judge(Station(pending: 4, oldest: TimeSpan.FromSeconds(61)) with { ReadFailing = true, ReadProblem = CloudProblem.Network, ReadError = OptiCloudException.Unreachable });

        Assert.Equal(CloudState.Offline, s.State);
        Assert.Equal($"Offline · 4 scanninger venter · sidst sendt {Now.AddMinutes(-5):HH':'mm}", s.Text);
        Assert.Equal("Ingen forbindelse til OptiCloud. Scanninger gemmes på PC'en og sendes automatisk (4 venter). Fortsæt som normalt.", s.Banner);
    }

    [Fact]
    public void Reads_working_while_scans_fail_to_send_is_not_green()
    {
        // Every poll works, but the oldest scan has waited two minutes: the old rule showed green here.
        var s = Judge(Station(pending: 1, oldest: TimeSpan.FromMinutes(2)) with { WriteProblem = CloudProblem.Network, WriteError = "OptiCloud har en fejl (500)" });

        Assert.Equal(CloudState.Offline, s.State);
        Assert.StartsWith("Sender ikke · 1 scanning venter", s.Text);
        Assert.Contains("sidst sendt", s.Text);
        Assert.StartsWith("Scanninger kan ikke sendes til OptiCloud lige nu.", s.Banner);
    }

    [Fact]
    public void A_short_outage_with_nothing_waiting_stays_green()
    {
        var s = Judge(Station() with { ReadFailing = true, ReadProblem = CloudProblem.Network, LastRead = Now.AddSeconds(-40) });

        Assert.Equal(CloudState.Online, s.State);
    }

    [Fact]
    public void An_outage_longer_than_a_minute_is_amber_even_with_nothing_waiting()
    {
        var s = Judge(Station() with { ReadFailing = true, ReadProblem = CloudProblem.Network, LastRead = Now.AddSeconds(-90), LastSent = null });

        Assert.Equal(CloudState.Offline, s.State);
        Assert.Equal("Offline", s.Text);
    }

    [Fact]
    public void A_refused_scan_is_red_not_green()
    {
        var s = Judge(Station() with { Refused = 2 });

        Assert.Equal(CloudState.Error, s.State);
        Assert.Equal("2 scanninger afvist, se log", s.Text);
    }

    [Fact]
    public void A_user_without_access_to_write_is_red_even_while_reads_work()
    {
        var s = Judge(Station(pending: 1, oldest: TimeSpan.FromSeconds(5)) with { WriteProblem = CloudProblem.Auth, WriteError = OptiCloudException.Forbidden });

        Assert.Equal(CloudState.Error, s.State);
        Assert.StartsWith($"Fejl: {OptiCloudException.Forbidden} · 1 scanning venter", s.Text);
    }

    [Fact]
    public void A_machine_order_failing_for_more_than_a_minute_is_amber()
    {
        Assert.Equal(CloudState.Online, Judge(Station() with { OrdersFailingFor = TimeSpan.FromSeconds(30) }).State);

        var s = Judge(Station() with { OrdersFailingFor = TimeSpan.FromMinutes(2) });

        Assert.Equal(CloudState.Warning, s.State);
        Assert.Equal("Forbundet · Ventisol · Ordre til maskine ikke sendt", s.Text);
    }

    [Fact]
    public void A_pc_clock_more_than_a_minute_off_is_amber_and_says_by_how_much()
    {
        Assert.Equal(CloudState.Online, Judge(Station() with { ClockSkew = TimeSpan.FromSeconds(50) }).State);

        var s = Judge(Station() with { ClockSkew = TimeSpan.FromMinutes(-3.2) });

        Assert.Equal(CloudState.Warning, s.State);
        Assert.Equal("Forbundet · Ventisol · PC'ens ur går 3 min forkert", s.Text);
    }

    [Fact]
    public void A_viewer_is_amber_as_soon_as_a_read_fails_and_stale_after_half_a_minute()
    {
        var viewer = new CloudFacts(StationMode.Viewer, true, Now.AddHours(-1), "Ventisol", LastRead: Now.AddSeconds(-20), ReadFailing: true, ReadProblem: CloudProblem.Network);
        var fresh = Judge(viewer);
        var stale = Judge(viewer with { LastRead = Now.AddSeconds(-45) });

        Assert.Equal(CloudState.Offline, fresh.State);
        Assert.Null(fresh.Banner);
        Assert.Null(CloudHealth.StaleText(fresh, Now));
        Assert.Equal($"Data fra {Now.AddSeconds(-45):HH':'mm} · ingen forbindelse til OptiCloud", CloudHealth.StaleText(stale, Now));
        Assert.StartsWith("Kan mangle scanninger", CloudHealth.ReportNote(StationMode.Viewer, stale, Now));
    }

    [Fact]
    public void A_viewer_that_never_read_waits_for_opticloud_not_for_a_scan()
    {
        Assert.Equal("Venter på OptiCloud…", CloudHealth.IdleText(StationMode.Viewer, hasRead: false));
        Assert.Equal("Venter på scanning", CloudHealth.IdleText(StationMode.Viewer, hasRead: true));
        Assert.Equal("Scan et element", CloudHealth.IdleText(StationMode.Scan, hasRead: false));
    }

    [Fact]
    public void An_offline_scan_station_says_its_report_holds_only_its_own_scans_since_the_last_read()
    {
        var s = Judge(Station(pending: 1, oldest: TimeSpan.FromMinutes(3)) with { ReadFailing = true, ReadProblem = CloudProblem.Network, LastRead = Now.AddMinutes(-3) });

        Assert.Equal($"Kun denne PC's scanninger siden {Now.AddMinutes(-3):HH':'mm}", CloudHealth.ReportNote(StationMode.Scan, s, Now));
        Assert.Null(CloudHealth.ReportNote(StationMode.Scan, Judge(Station()), Now));
    }

    [Fact(Timeout = 10000)]
    public async Task The_client_reads_the_clock_of_opticloud_from_the_date_header()
    {
        var api = new FakeOptiCloud
        {
            Override = (_, path, _) =>
            {
                if (!path.Contains("login")) return null;
                var r = FakeOptiCloud.Json(new { access_token = "t", expires_in = 3600 });
                r.Headers.Date = DateTimeOffset.UtcNow.AddMinutes(-5);
                return r;
            },
        };
        using var client = api.Client();
        Assert.Null(client.ClockSkew);

        await client.LoginAsync();

        Assert.InRange(client.ClockSkew!.Value.TotalMinutes, 4.9, 5.1);
        Assert.Equal("PC'ens ur går 5 min forkert", CloudHealth.ClockText(client.ClockSkew));
    }
}
