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

    [Fact]
    public void Max_i_gang_and_marker_efter_survive_a_round_trip()
    {
        var s = Configured() with
        {
            Stations = [.. Configured().Stations.Select(t => t.Number == 3 ? t with { MaxActive = 4 } : t)],
            MarkAfterHours = 6,
        };
        var back = StationSettingsJson.Deserialize(StationSettingsJson.Serialize(s))!;

        Assert.Equal(4, back.Stations[2].MaxActive);
        Assert.Equal(4, back.Stations[2].Config.MaxActive);
        Assert.Equal(1, back.Stations[0].MaxActive);
        Assert.Equal(6, back.MarkAfterHours);
    }

    [Fact]
    public void An_older_file_without_max_i_gang_reads_as_one_at_a_time_and_marks_after_4_hours()
    {
        var back = StationSettingsJson.Deserialize("""
            { "version": 1, "mode": "Scan", "apiBaseUrl": "https://api.optipeople.dk",
              "stations": [ { "number": 1, "name": "Station 10", "kind": "Assembly", "machineId": null, "scannerSerial": "keyboard" } ] }
            """)!;

        Assert.All(back.Stations, t => Assert.Equal(1, t.MaxActive));
        Assert.Equal(StationSettings.DefaultMarkAfterHours, back.MarkAfterHours);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(-3, 1)]
    [InlineData(6, 6)]
    [InlineData(99, StationConfig.MaxActiveLimit)]
    public void Max_i_gang_is_kept_to_1_to_20(int given, int kept)
    {
        var s = StationSettings.Default with { Stations = [.. StationSettings.Default.Stations.Select(t => t with { MaxActive = given })] };
        Assert.All(StationSettingsJson.Normalize(s).Stations, t => Assert.Equal(kept, t.MaxActive));
    }

    [Theory]
    [InlineData(0, 4)]
    [InlineData(1, 1)]
    [InlineData(500, StationSettings.MaxMarkAfterHours)]
    public void Marker_efter_is_kept_to_1_to_48_hours(int given, int kept) =>
        Assert.Equal(kept, StationSettingsJson.Normalize(StationSettings.Default with { MarkAfterHours = given }).MarkAfterHours);

    // ----- Arbejdsform

    static StationSettings WithModes(params (int Number, StationWorkMode Mode, int MaxActive)[] changes) => Configured() with
    {
        Stations = [.. Configured().Stations.Select(t => changes.FirstOrDefault(c => c.Number == t.Number) is { Number: > 0 } c
            ? t with { WorkMode = c.Mode, MaxActive = c.MaxActive } : t)],
    };

    [Fact]
    public void An_older_file_without_arbejdsform_reads_as_enkel()
    {
        var back = StationSettingsJson.Deserialize("""
            { "version": 1, "mode": "Scan", "apiBaseUrl": "https://api.optipeople.dk",
              "stations": [ { "number": 1, "name": "Station 10", "kind": "Assembly", "maxActive": 3 } ] }
            """)!;

        Assert.All(back.Stations, t => Assert.Equal(StationWorkMode.Enkel, t.WorkMode));
        Assert.Equal(StationWorkMode.Enkel, back.Stations[0].Config.WorkMode);
        Assert.Equal(StationWorkMode.Enkel, StationSettings.Default.Stations[0].WorkMode);
    }

    [Theory]
    [InlineData("Montage")]
    [InlineData("2")]
    [InlineData("")]
    [InlineData("  ")]
    public void An_unknown_arbejdsform_reads_as_enkel_and_the_rest_of_the_file_is_kept(string text)
    {
        var logged = new List<string>();
        var back = StationSettingsJson.Deserialize($$"""
            { "version": 1, "mode": "Viewer", "username": "ventisol",
              "stations": [ { "number": 3, "name": "Svejs", "kind": "Packing", "maxActive": 4, "workMode": "{{text}}" },
                            { "number": 4, "name": "Station 40", "kind": "Assembly", "workMode": "Session" } ] }
            """, logged.Add)!;

        Assert.NotNull(back);
        Assert.Equal(StationMode.Viewer, back.Mode);
        Assert.Equal(StationWorkMode.Enkel, back.Stations[2].WorkMode);
        Assert.Equal(4, back.Stations[2].MaxActive);
        Assert.Equal("Svejs", back.Stations[2].Name);
        Assert.Equal(StationWorkMode.Session, back.Stations[3].WorkMode);
        if (string.IsNullOrWhiteSpace(text)) Assert.Empty(logged);
        else Assert.Contains(text, Assert.Single(logged));
    }

    [Fact]
    public void A_null_arbejdsform_reads_as_enkel() =>
        Assert.Equal(StationWorkMode.Enkel, StationSettingsJson.Deserialize("""
            { "version": 1, "mode": "Scan", "stations": [ { "number": 1, "name": "A", "kind": "Assembly", "workMode": null } ] }
            """)!.Stations[0].WorkMode);

    [Theory]
    [InlineData("session", StationWorkMode.Session)]
    [InlineData(" PAKNING ", StationWorkMode.Pakning)]
    [InlineData("Enkel", StationWorkMode.Enkel)]
    public void Arbejdsform_text_is_read_in_any_case(string text, StationWorkMode mode) =>
        Assert.Equal(mode, StationSettingsJson.ParseWorkMode(text));

    [Fact]
    public void Arbejdsform_survives_a_round_trip_pakning_too()
    {
        var s = WithModes((2, StationWorkMode.Session, 4), (7, StationWorkMode.Pakning, 1));
        var json = StationSettingsJson.Serialize(s);
        var back = StationSettingsJson.Deserialize(json)!;

        Assert.Contains("\"workMode\": \"Session\"", json);
        Assert.Contains("\"workMode\": \"Pakning\"", json);
        Assert.Equal(s.Stations, back.Stations);
        Assert.Equal(StationWorkMode.Session, back.Stations[1].Config.WorkMode);
        Assert.Equal(StationWorkMode.Pakning, back.Stations[6].WorkMode);
        Assert.Equal(StationWorkMode.Enkel, back.Stations[0].WorkMode);
    }

    [Fact]
    public void Normalize_keeps_pakning_and_makes_an_undefined_value_enkel()
    {
        var s = WithModes((1, StationWorkMode.Pakning, 1), (2, (StationWorkMode)42, 1));
        var n = StationSettingsJson.Normalize(s);

        Assert.Equal(StationWorkMode.Pakning, n.Stations[0].WorkMode);
        Assert.Equal(StationWorkMode.Enkel, n.Stations[1].WorkMode);
    }

    [Fact]
    public void The_drop_down_offers_enkel_and_session_with_their_labels()
    {
        Assert.Equal([StationWorkMode.Enkel], SetupRules.OfferedWorkModes);
        Assert.Equal("Enkel (scan ind / scan ud)", SetupRules.WorkModeLabel(StationWorkMode.Enkel));
        Assert.Equal("Session (Start / Pause / Hold)", SetupRules.WorkModeLabel(StationWorkMode.Session));
        Assert.Equal("Pakning (tjekliste og paller)", SetupRules.WorkModeLabel(StationWorkMode.Pakning));
    }

    [Fact]
    public void Session_with_max_1_gets_a_hint_that_does_not_stop_a_save()
    {
        var s = WithModes((1, StationWorkMode.Session, 1), (2, StationWorkMode.Session, 3), (3, StationWorkMode.Enkel, 1));

        var hints = SetupRules.Hints(s);
        Assert.Equal("Session med Maks 1: ét element ad gangen", Assert.Single(hints, h => h.Key == 1).Value);
        Assert.Single(hints);
        Assert.Empty(SetupRules.Problems(s));
    }

    [Fact]
    public void Changing_arbejdsform_warns_of_the_elements_on_pause()
    {
        var before = WithModes((3, StationWorkMode.Session, 4), (4, StationWorkMode.Session, 4), (5, StationWorkMode.Session, 4));
        var after = WithModes((3, StationWorkMode.Enkel, 4), (4, StationWorkMode.Enkel, 4), (5, StationWorkMode.Session, 4));
        after = after with { Stations = [.. after.Stations.Select(t => t.Number == 3 ? t with { Name = "Station 30" } : t)] };
        var paused = new Dictionary<int, int> { [3] = 3, [4] = 1, [5] = 2, [6] = 2 };

        var w = SetupRules.ModeChanges(before, after, paused);

        Assert.Equal([3, 4], w.Keys.Order());
        Assert.Equal("Station 30 har 3 elementer på pause. De afsluttes, når du gemmer.", w[3]);
        Assert.Equal("Station 40 har 1 element på pause. Det afsluttes, når du gemmer.", w[4]);
        Assert.Empty(SetupRules.ModeChanges(before, after, new Dictionary<int, int>()));
        Assert.Empty(SetupRules.Problems(after));
    }

    // ----- Vagtslut

    static readonly StandardShift Day = new(new TimeOnly(6, 0), new TimeOnly(14, 0));

    [Fact]
    public void A_file_without_vagtslut_reads_the_defaults()
    {
        var back = StationSettingsJson.Deserialize("""{ "version": 1, "mode": "Scan", "stations": [] }""");

        Assert.NotNull(back);
        Assert.True(back.ShiftEndOn);
        Assert.Equal(60, back.ShiftEndGraceMinutes);
        Assert.Null(back.StandardShift);
        Assert.True(StationSettings.Default.ShiftEndOn);
        Assert.Equal(60, StationSettings.Default.ShiftEndGraceMinutes);
        Assert.Null(StationSettings.Default.StandardShift);
    }

    [Fact]
    public void Vagtslut_survives_a_round_trip_through_json()
    {
        var s = Configured() with { ShiftEndOn = false, ShiftEndGraceMinutes = 45, StandardShift = Day };
        var json = StationSettingsJson.Serialize(s);
        var back = StationSettingsJson.Deserialize(json);

        Assert.Contains("\"start\": \"06:00\"", json);
        Assert.Contains("\"end\": \"14:00\"", json);
        Assert.NotNull(back);
        Assert.False(back.ShiftEndOn);
        Assert.Equal(45, back.ShiftEndGraceMinutes);
        Assert.Equal(Day, back.StandardShift);

        var none = StationSettingsJson.Deserialize(StationSettingsJson.Serialize(Configured()));
        Assert.True(none!.ShiftEndOn);
        Assert.Null(none.StandardShift);
    }

    [Theory]
    [InlineData(0, 60)]
    [InlineData(-5, 60)]
    [InlineData(1, 15)]
    [InlineData(15, 15)]
    [InlineData(37, 37)]
    [InlineData(90, 90)]
    [InlineData(500, 90)]
    public void The_grace_is_kept_to_15_to_90_minutes(int given, int kept)
    {
        Assert.Equal(kept, StationSettingsJson.Normalize(StationSettings.Default with { ShiftEndGraceMinutes = given }).ShiftEndGraceMinutes);
        var back = StationSettingsJson.Deserialize($$"""{ "version": 1, "mode": "Scan", "shiftEndGraceMinutes": {{given}} }""");
        Assert.Equal(kept, back!.ShiftEndGraceMinutes);
    }

    [Fact]
    public void A_standard_shift_that_cannot_be_read_is_none_and_logged()
    {
        var log = new List<string>();
        var back = StationSettingsJson.Deserialize("""
            { "version": 1, "mode": "Scan", "shiftEndOn": true, "standardShift": { "start": "6 om morgenen", "end": "14:00" } }
            """, log.Add);

        Assert.NotNull(back);
        Assert.Null(back.StandardShift);
        Assert.Contains("standard shift", Assert.Single(log));
    }

    [Fact]
    public void A_standard_shift_is_kept_to_whole_minutes_and_one_of_no_length_is_none()
    {
        var odd = new StandardShift(new TimeOnly(6, 0, 30), new TimeOnly(14, 0, 59));
        Assert.Equal(Day, StationSettingsJson.Normalize(StationSettings.Default with { StandardShift = odd }).StandardShift);
        var empty = new StandardShift(new TimeOnly(6, 0), new TimeOnly(6, 0));
        Assert.Null(StationSettingsJson.Normalize(StationSettings.Default with { StandardShift = empty }).StandardShift);
    }

    [Fact]
    public void The_source_text_says_where_the_shifts_come_from()
    {
        var on = StationSettings.Default;
        Assert.Equal("Ingen vagter – stopper ikke ved vagtslut", SetupRules.ShiftSource(on));
        Assert.Equal("Bruger standardvagt 06:00–14:00", SetupRules.ShiftSource(on with { StandardShift = Day }));
        Assert.Equal("Vagter fra OptiPeople: man–fre 06:00–14:00", SetupRules.ShiftSource(on with { StandardShift = Day }, "man–fre 06:00–14:00"));
        Assert.Equal("Stop ved vagtslut er slået fra", SetupRules.ShiftSource(on with { ShiftEndOn = false, StandardShift = Day }));
        Assert.Equal("Stop ved vagtslut er slået fra", SetupRules.ShiftSource(on with { ShiftEndOn = false }, "man–fre 06:00–14:00"));
    }

    [Fact]
    public void A_standard_shift_that_ends_before_it_starts_gets_a_hint_not_a_refusal()
    {
        var night = new StandardShift(new TimeOnly(22, 0), new TimeOnly(6, 0));
        var s = StationSettings.Default with { StandardShift = night };

        Assert.Equal("Standardvagt slutter før den starter", SetupRules.StandardShiftHint(night));
        Assert.Null(SetupRules.StandardShiftHint(Day));
        Assert.Null(SetupRules.StandardShiftHint(null));
        Assert.Empty(SetupRules.Problems(s));
        Assert.Null(SetupRules.StandardShiftProblem(night.Start, night.End));
        Assert.Equal("Bruger standardvagt 22:00–06:00", SetupRules.ShiftSource(s));
    }

    [Fact]
    public void A_half_chosen_standard_shift_stops_a_save()
    {
        Assert.Null(SetupRules.StandardShiftProblem(null, null));
        Assert.Null(SetupRules.StandardShiftProblem(Day.Start, Day.End));
        Assert.Equal("Standardvagt mangler sluttid", SetupRules.StandardShiftProblem(Day.Start, null));
        Assert.Equal("Standardvagt mangler starttid", SetupRules.StandardShiftProblem(null, Day.End));
        Assert.Equal("Standardvagt starter og slutter på samme tid", SetupRules.StandardShiftProblem(Day.Start, Day.Start));
    }

    [Theory]
    [InlineData("06:00", 6, 0)]
    [InlineData("6:00", 6, 0)]
    [InlineData(" 0630 ", 6, 30)]
    [InlineData("22.15", 22, 15)]
    public void Shift_times_are_read_as_typed(string text, int h, int m) =>
        Assert.Equal(new TimeOnly(h, m), StandardShift.ParseTime(text));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("25:00")]
    [InlineData("morgen")]
    public void Other_text_is_no_shift_time(string? text) => Assert.Null(StandardShift.ParseTime(text));
}
