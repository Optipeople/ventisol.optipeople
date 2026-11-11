namespace Ventisol.Station.Tests;

// The app's own files on the PC (not Core): the atomic write every store uses, the restart count
// that breaks a restart loop, and the setup PIN.
public sealed class AppFilesTests : IDisposable
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 6, 0, 0, TimeSpan.Zero);
    readonly string _folder = Path.Combine(Path.GetTempPath(), "ventisol-appfiles-" + Guid.NewGuid().ToString("N"));
    readonly List<string> _log = [];
    DateTimeOffset _now = T0;

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch (IOException) { }
    }

    SetupPin Pin() => new(_folder, _log.Add, () => _now);

    // ----- AtomicFile

    [Fact]
    public void A_write_makes_the_folder_replaces_the_file_and_leaves_no_temp_file()
    {
        var file = Path.Combine(_folder, "deep", "settings.json");

        AtomicFile.Write(file, "one");
        AtomicFile.Write(file, "two");

        Assert.Equal("two", File.ReadAllText(file));
        Assert.Equal("settings.json", Path.GetFileName(Assert.Single(Directory.GetFiles(Path.GetDirectoryName(file)!))));
    }

    [Fact]
    public void A_write_that_fails_says_so_and_keeps_the_old_file()
    {
        var file = Path.Combine(_folder, "layout.json");
        AtomicFile.Write(file, "old");
        // A folder where the temp file should go makes the write fail.
        Directory.CreateDirectory(file + ".tmp");

        Assert.False(AtomicFile.TryWrite(file, "new", _log.Add));

        Assert.Equal("old", File.ReadAllText(file));
        Assert.Contains(_log, l => l.StartsWith("layout.json not saved"));
    }

    [Fact]
    public void A_missing_file_reads_as_nothing_without_a_log_line()
    {
        Assert.Null(AtomicFile.TryRead(Path.Combine(_folder, "none.json"), _log.Add));
        Assert.Empty(_log);
    }

    [Fact]
    public void A_file_that_cannot_be_read_is_logged()
    {
        var file = Path.Combine(_folder, "window.json");
        Directory.CreateDirectory(file); // A folder by the file's name can't be read as a file.

        Assert.Null(AtomicFile.TryRead(file, _log.Add));
        Assert.Contains(_log, l => l.StartsWith("window.json could not be read"));
    }

    // ----- RestartLog

    [Fact]
    public void Restarts_are_counted_across_instances_and_the_wait_grows()
    {
        Assert.Equal(1, new RestartLog(_folder, _log.Add).Record(T0));
        Assert.Equal(2, new RestartLog(_folder, _log.Add).Record(T0.AddSeconds(5)));
        Assert.Equal(3, new RestartLog(_folder, _log.Add).Record(T0.AddSeconds(20)));

        Assert.Equal(TimeSpan.Zero, RestartLog.DelayFor(1));
        Assert.True(RestartLog.DelayFor(2) < RestartLog.DelayFor(3));
        Assert.True(RestartLog.DelayFor(3) < RestartLog.DelayFor(4));
        Assert.Equal(RestartLog.DelayFor(6), RestartLog.DelayFor(60));
    }

    [Fact]
    public void A_first_restart_starts_at_once_and_later_ones_wait_what_is_left()
    {
        var log = new RestartLog(_folder, _log.Add);
        Assert.Equal(TimeSpan.Zero, log.WaitBeforeStart(T0));

        log.Record(T0);
        Assert.Equal(TimeSpan.Zero, log.WaitBeforeStart(T0.AddSeconds(1)));

        log.Record(T0.AddSeconds(2));
        Assert.Equal(RestartLog.DelayFor(2) - TimeSpan.FromSeconds(1), log.WaitBeforeStart(T0.AddSeconds(3)));
        // Started long after the restart (someone turned the PC on again): no wait.
        Assert.Equal(TimeSpan.Zero, log.WaitBeforeStart(T0.AddMinutes(5)));
    }

    [Fact]
    public void Restarts_older_than_an_hour_no_longer_count()
    {
        var log = new RestartLog(_folder, _log.Add);
        log.Record(T0);
        log.Record(T0.AddMinutes(1));

        Assert.Equal(2, log.Count(T0.AddMinutes(30)));
        Assert.Equal(0, log.Count(T0.AddMinutes(62)));
        Assert.Equal(1, log.Record(T0.AddMinutes(62)));
    }

    [Fact]
    public void A_restart_file_that_cannot_be_read_counts_as_none()
    {
        Directory.CreateDirectory(_folder);
        File.WriteAllText(Path.Combine(_folder, "restarts.json"), "{ not json");

        Assert.Equal(0, new RestartLog(_folder, _log.Add).Count(T0));
        Assert.Contains(_log, l => l.StartsWith("restarts.json could not be read"));
    }

    // ----- SetupPin

    [Fact]
    public void With_no_pin_set_everything_is_open()
    {
        var pin = Pin();

        Assert.False(pin.IsSet);
        Assert.Equal(PinAnswer.Ok, pin.Check(""));
        Assert.Equal(PinAnswer.Ok, pin.Check("0000"));
    }

    [Theory]
    [InlineData("1234", true)]
    [InlineData("12345678", true)]
    [InlineData("123", false)]
    [InlineData("123456789", false)]
    [InlineData("12a4", false)]
    [InlineData("12 4", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void A_pin_is_four_to_eight_digits(string? pin, bool valid)
    {
        Assert.Equal(valid, SetupPin.IsValid(pin));
        if (!valid && pin is not null) Assert.False(Pin().Set(pin));
    }

    [Fact]
    public void A_set_pin_is_asked_for_after_a_restart_and_never_written_down()
    {
        Assert.True(Pin().Set("482615"));

        var again = Pin();
        Assert.True(again.IsSet);
        Assert.Equal(PinAnswer.Wrong, again.Check("482616"));
        Assert.Equal(PinAnswer.Ok, again.Check("482615"));
        Assert.All(Directory.GetFiles(_folder), f => Assert.DoesNotContain("482615", File.ReadAllText(f)));
        Assert.DoesNotContain(_log, l => l.Contains("482615") || l.Contains("482616"));
    }

    [Fact]
    public void The_same_pin_set_twice_is_stored_differently()
    {
        var file = Path.Combine(_folder, "setup-pin.json");
        Pin().Set("1234");
        var first = File.ReadAllText(file);
        Pin().Set("1234");

        Assert.NotEqual(first, File.ReadAllText(file));
    }

    [Fact]
    public void Three_wrong_tries_make_the_next_one_wait_also_after_a_restart()
    {
        Pin().Set("1234");
        var pin = Pin();
        Assert.Equal(PinAnswer.Wrong, pin.Check("0000"));
        Assert.Equal(PinAnswer.Wrong, pin.Check("0001"));
        Assert.Equal(TimeSpan.Zero, pin.LockedFor);
        Assert.Equal(PinAnswer.Wrong, pin.Check("0002"));
        Assert.Equal(TimeSpan.FromSeconds(30), pin.LockedFor);

        // During the wait even the right PIN is turned down, in a new process too.
        Assert.Equal(PinAnswer.Locked, pin.Check("1234"));
        Assert.Equal(PinAnswer.Locked, Pin().Check("1234"));

        _now = T0.AddSeconds(31);
        Assert.Equal(PinAnswer.Ok, Pin().Check("1234"));
    }

    [Fact]
    public void Each_wrong_try_after_the_wait_doubles_it_up_to_ten_minutes()
    {
        Pin().Set("1234");
        var pin = Pin();
        for (var i = 0; i < 3; i++) pin.Check("0000");

        _now += TimeSpan.FromSeconds(31);
        Assert.Equal(PinAnswer.Wrong, pin.Check("0000"));
        Assert.Equal(TimeSpan.FromSeconds(60), pin.LockedFor);

        for (var i = 0; i < 10; i++)
        {
            _now += TimeSpan.FromMinutes(11);
            pin.Check("0000");
        }
        Assert.Equal(TimeSpan.FromMinutes(10), pin.LockedFor);
    }

    [Fact]
    public void The_right_pin_clears_the_wrong_tries()
    {
        Pin().Set("1234");
        var pin = Pin();
        pin.Check("0000");
        pin.Check("0000");
        Assert.Equal(PinAnswer.Ok, pin.Check("1234"));

        pin.Check("0000");
        pin.Check("0000");
        Assert.Equal(TimeSpan.Zero, pin.LockedFor);
    }

    [Fact]
    public void A_removed_pin_opens_everything_again()
    {
        Pin().Set("1234");
        var pin = Pin();
        Assert.True(pin.Clear());

        Assert.False(Pin().IsSet);
        Assert.Equal(PinAnswer.Ok, Pin().Check("9999"));
    }

    [Fact]
    public void A_pin_file_that_cannot_be_read_keeps_the_setup_shut()
    {
        Directory.CreateDirectory(_folder);
        File.WriteAllText(Path.Combine(_folder, "setup-pin.json"), "{}");
        var pin = Pin();

        Assert.True(pin.IsSet);
        Assert.Equal(PinAnswer.Wrong, pin.Check("1234"));
        Assert.Contains(_log, l => l.Contains("could not be read"));
    }

    [Fact]
    public void A_clock_set_back_never_locks_for_longer_than_the_longest_wait()
    {
        Pin().Set("1234");
        var pin = Pin();
        for (var i = 0; i < 3; i++) pin.Check("0000");

        _now = T0.AddDays(-30);
        Assert.Equal(TimeSpan.FromMinutes(10), Pin().LockedFor);
    }
}
