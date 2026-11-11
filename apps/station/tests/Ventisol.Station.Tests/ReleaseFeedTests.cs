using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class ReleaseFeedTests
{
    // As the updates repo serves it for 1.0.6.
    const string Feed = """
        {"Assets":[
          {"PackageId":"VentisolStation","Version":"1.0.6","Type":"Full","FileName":"VentisolStation-1.0.6-full.nupkg","Size":76807706},
          {"PackageId":"VentisolStation","Version":"1.0.6","Type":"Delta","FileName":"VentisolStation-1.0.6-delta.nupkg","Size":167390}
        ]}
        """;

    [Fact]
    public void Feed_url_is_the_latest_release_download_link()
    {
        Assert.Equal(
            "https://github.com/Optipeople/ventisol.station.updates/releases/latest/download/releases.win.json",
            ReleaseFeed.LatestFeedUrl("https://github.com/Optipeople/ventisol.station.updates/"));
        Assert.Null(ReleaseFeed.LatestFeedUrl(@"C:\releases"));
    }

    [Fact]
    public void Latest_full_version_is_read()
    {
        Assert.Equal(new Version(1, 0, 6), ReleaseFeed.LatestFullVersion(Feed));
    }

    [Fact]
    public void Highest_full_wins_and_deltas_and_prereleases_are_ignored()
    {
        const string json = """
            {"Assets":[
              {"Version":"1.0.9","Type":"Delta"},
              {"Version":"1.0.10","Type":"Full"},
              {"Version":"1.0.7","Type":"Full"},
              {"Version":"1.1.0-beta1","Type":"Full"}
            ]}
            """;
        Assert.Equal(new Version(1, 0, 10), ReleaseFeed.LatestFullVersion(json));
    }

    [Theory]
    [InlineData("")]
    [InlineData("<html>Not Found</html>")]
    [InlineData("{}")]
    [InlineData("""{"Assets":[]}""")]
    [InlineData("""{"Assets":[{"Version":"x","Type":"Full"}]}""")]
    public void Unreadable_feed_is_null(string json)
    {
        Assert.Null(ReleaseFeed.LatestFullVersion(json));
    }
}
