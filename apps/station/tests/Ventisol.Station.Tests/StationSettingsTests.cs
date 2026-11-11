using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class StationSettingsTests
{
    static readonly Guid Account = Guid.Parse("4d1f0c4e-2b8a-4c39-9a51-6c0f6f2b7e11");
    static readonly Guid Machine = Guid.Parse("a3c9b2d0-1111-4e2f-8f00-0123456789ab");

    static StationSettings Configured() => SetupRules.AssignScanner(
        StationSettings.Default with
        {
            Mode = StationMode.Viewer,
            AccountId = Account,
            Username = "ventisol",
            Stations = [.. StationSettings.Default.Stations.Select(t => t.Number == 3 ? t with { Name = "Svejs", MachineId = Machine } : t)],
        }, 3, "SER-0003");

    [Fact]
    public void Settings_survive_a_round_trip_through_json()
    {
        var s = Configured();
        var back = StationSettingsJson.Deserialize(StationSettingsJson.Serialize(s));

        Assert.NotNull(back);
        Assert.Equal(StationMode.Viewer, back.Mode);
        Assert.Equal(StationSettings.DefaultApiBaseUrl, back.ApiBaseUrl);
        Assert.Equal(Account, back.AccountId);
        Assert.Equal("ventisol", back.Username);
        Assert.Equal(s.Stations, back.Stations);
        Assert.True(back.IsConnected);
    }

    [Fact]
    public void The_file_is_readable_and_holds_no_password()
    {
        var json = StationSettingsJson.Serialize(Configured());
        Assert.Contains("\"mode\": \"Viewer\"", json);
        Assert.Contains("\"kind\": \"Packing\"", json);
        Assert.DoesNotContain("password", json, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[1,2,3]")]
    [InlineData("null")]
    public void Unreadable_text_gives_null(string json) => Assert.Null(StationSettingsJson.Deserialize(json));

    [Fact]
    public void A_partial_file_is_made_whole()
    {
        var back = StationSettingsJson.Deserialize("""
            { "version": 1, "mode": "Scan", "apiBaseUrl": " https://test.optipeople.dk/ ", "username": "  ",
              "stations": [ { "number": 2, "name": "  ", "kind": "Packing", "scannerSerial": "A" },
                            { "number": 5, "name": "Bord", "scannerSerial": "a" },
                            { "number": 99, "name": "Ukendt" } ] }
            """);

        Assert.NotNull(back);
        Assert.Equal("https://test.optipeople.dk", back.ApiBaseUrl);
        Assert.Null(back.Username);
        Assert.Equal([1, 2, 3, 4, 5, 6, 7], back.Stations.Select(t => t.Number));
        Assert.Equal("Station 20", back.Stations[1].Name);
        Assert.Equal(StationKind.Packing, back.Stations[1].Kind);
        Assert.Equal("A", back.Stations[1].ScannerSerial);
        Assert.Equal("Bord", back.Stations[4].Name);
        Assert.Null(back.Stations[4].ScannerSerial); // the same scanner, already on station 2
        Assert.Equal(StationConfig.Defaults[6].Name, back.Stations[6].Name);
    }

    [Fact]
    public void A_scanner_moves_to_the_station_it_is_given_to()
    {
        var s = SetupRules.AssignScanner(Configured(), 5, "ser-0003");
        Assert.Null(s.Stations[2].ScannerSerial);
        Assert.Equal("ser-0003", s.Stations[4].ScannerSerial);

        var none = SetupRules.AssignScanner(s, 5, "  ");
        Assert.All(none.Stations, t => Assert.Null(t.ScannerSerial));
    }

    [Theory]
    [InlineData("", true, false)]
    [InlineData("  ", true, false)]
    [InlineData("4d1f0c4e-2b8a-4c39-9a51-6c0f6f2b7e11", true, true)]
    [InlineData("{4d1f0c4e-2b8a-4c39-9a51-6c0f6f2b7e11}", true, true)]
    [InlineData("00000000-0000-0000-0000-000000000000", false, false)]
    [InlineData("1234", false, false)]
    public void Account_ids_are_guids_or_blank(string text, bool ok, bool hasId)
    {
        Assert.Equal(ok, SetupRules.TryParseAccountId(text, out var id));
        Assert.Equal(hasId, id is not null);
    }

    [Fact]
    public void The_default_settings_can_be_saved() => Assert.Empty(SetupRules.Problems(StationSettings.Default));

    [Fact]
    public void Problems_name_what_is_wrong()
    {
        var s = StationSettings.Default with
        {
            ApiBaseUrl = "api.optipeople.dk",
            Stations = [.. StationSettings.Default.Stations.Select(t => t.Number switch
            {
                1 => t with { Name = " " },
                2 or 4 => t with { ScannerSerial = "X" },
                _ => t,
            })],
        };

        var p = SetupRules.Problems(s);
        Assert.Equal(3, p.Count);
        Assert.StartsWith("API-adressen", p[0]);
        Assert.Equal("Station 1 mangler et navn", p[1]);
        Assert.Equal("Samme scanner er sat på Station 20 og Station 40", p[2]);
    }

    [Theory]
    [InlineData("https://api.optipeople.dk", null)]
    [InlineData(" https://api.optipeople.dk/ ", null)]
    [InlineData("http://localhost:5099", null)]
    [InlineData("http://127.0.0.1:5099", null)]
    [InlineData("http://api.optipeople.dk", SetupRules.HttpsOnly)]
    [InlineData("http://192.168.1.20:5099", SetupRules.HttpsOnly)]
    [InlineData("http://localhost.example.com", SetupRules.HttpsOnly)]
    [InlineData("ftp://api.optipeople.dk", SetupRules.NotAnAddress)]
    [InlineData("api.optipeople.dk", SetupRules.NotAnAddress)]
    [InlineData("", SetupRules.NotAnAddress)]
    [InlineData(null, SetupRules.NotAnAddress)]
    public void The_api_address_is_https_or_this_pc(string? url, string? problem)
    {
        Assert.Equal(problem, SetupRules.ApiUrlProblem(url));
        Assert.Equal(problem is null, SetupRules.IsValidApiUrl(url));
    }

    [Fact]
    public void Plain_http_to_another_machine_stops_a_save()
    {
        var p = SetupRules.Problems(StationSettings.Default with { ApiBaseUrl = "http://api.optipeople.dk" });

        Assert.Equal([SetupRules.HttpsOnly], p);
        Assert.Empty(SetupRules.Problems(StationSettings.Default with { ApiBaseUrl = "http://localhost:5099" }));
    }
}
