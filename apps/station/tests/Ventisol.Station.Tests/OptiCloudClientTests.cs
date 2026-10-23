using System.Net;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.Tests;

public class OptiCloudClientTests
{
    [Fact(Timeout = 10000)]
    public async Task Logs_in_and_sends_the_token_as_bearer()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();

        var user = await client.GetCurrentUserAsync();

        Assert.Equal(FakeOptiCloud.Account, user.AccountId);
        Assert.Equal("Ventisol", user.AccountName);
        Assert.Equal("Bearer token-1", api.Requests.Last().Auth);
    }

    [Fact(Timeout = 10000)]
    public async Task Bad_credentials_with_a_200_and_errors_is_a_failed_login()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client("forkert");

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());

        Assert.Equal(OptiCloudException.BadLogin, e.Message);
        Assert.True(e.IsAuth);
    }

    [Theory(Timeout = 10000)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.BadRequest)]
    public async Task Bad_credentials_as_an_http_error_is_a_failed_login(HttpStatusCode status)
    {
        var api = new FakeOptiCloud { Override = (_, path, _) => path.Contains("login") ? new HttpResponseMessage(status) : null };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());

        Assert.Equal(OptiCloudException.BadLogin, e.Message);
    }

    [Fact(Timeout = 10000)]
    public async Task A_200_without_a_token_is_not_a_login()
    {
        var api = new FakeOptiCloud { Override = (_, path, _) => path.Contains("login") ? FakeOptiCloud.Json(new { user_name = "x" }) : null };
        using var client = api.Client();

        await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());
        Assert.False(client.IsLoggedIn);
    }

    [Fact(Timeout = 10000)]
    public async Task A_401_refreshes_the_token_and_tries_once_more()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        await client.LoginAsync();
        api.ExpireToken();

        var machines = await client.GetMachinesAsync(FakeOptiCloud.Account);

        Assert.Equal(3, machines.Count);
        Assert.Equal(1, api.LoginCount("\"password\""));
        Assert.Equal(1, api.LoginCount("refresh_token"));
        Assert.Contains("\"username\":\"ventisol\"", api.Requests.Single(r => r.Body?.Contains("refresh_token") == true).Body);
        Assert.Equal(2, api.Count("GetByAccountId"));
    }

    [Fact(Timeout = 10000)]
    public async Task When_the_refresh_fails_it_logs_in_with_the_password()
    {
        var api = new FakeOptiCloud { RefreshWorks = false };
        using var client = api.Client();
        await client.LoginAsync();
        api.ExpireToken();

        await client.GetMachinesAsync(FakeOptiCloud.Account);

        Assert.Equal(2, api.LoginCount("\"password\""));
    }

    [Fact(Timeout = 10000)]
    public async Task A_second_401_after_renewing_is_not_retried_again()
    {
        var api = new FakeOptiCloud { Override = (_, path, _) => path.Contains("GetCurrentUser") ? new HttpResponseMessage(HttpStatusCode.Unauthorized) : null };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.GetCurrentUserAsync());

        Assert.Equal(401, e.Status);
        Assert.Equal(2, api.Count("GetCurrentUser"));
    }

    [Fact(Timeout = 10000)]
    public async Task Callers_hitting_a_401_together_share_one_refresh()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        await client.LoginAsync();
        api.ExpireToken();
        api.LoginDelay = TimeSpan.FromMilliseconds(100);

        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => client.GetMachinesAsync(FakeOptiCloud.Account)));

        Assert.Equal(1, api.LoginCount("refresh_token"));
    }

    [Fact(Timeout = 10000)]
    public async Task Errors_in_the_envelope_are_failures_also_with_a_200()
    {
        var api = new FakeOptiCloud
        {
            Override = (_, path, _) => path.Contains("GetByAccountId")
                ? FakeOptiCloud.Json(new { data = (object?)null, errors = new[] { new { title = "Forbidden", message = "Ingen adgang til kontoen" } } })
                : null,
        };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.GetMachinesAsync(FakeOptiCloud.Account));

        Assert.Equal("OptiCloud svarede: Ingen adgang til kontoen", e.Message);
        Assert.True(e.IsRejected);
    }

    [Fact(Timeout = 10000)]
    public async Task No_network_is_unreachable_and_worth_retrying()
    {
        var api = new FakeOptiCloud { Down = true };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());

        Assert.Equal(OptiCloudException.Unreachable, e.Message);
        Assert.False(e.IsRejected || e.IsAuth);
    }

    [Fact(Timeout = 10000)]
    public async Task An_unexpected_shape_is_a_clear_error_not_a_crash()
    {
        var api = new FakeOptiCloud { Override = (_, path, _) => path.Contains("GetByAccountId") ? FakeOptiCloud.Json(new { data = "hello" }) : null };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.GetMachinesAsync(FakeOptiCloud.Account));

        Assert.Equal(OptiCloudException.Unexpected, e.Message);
    }

    [Fact(Timeout = 10000)]
    public async Task A_server_error_is_not_a_rejection()
    {
        var api = new FakeOptiCloud { Override = (_, path, _) => path.Contains("GetTables") ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : null };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.GetTablesAsync(FakeOptiCloud.Account));

        Assert.False(e.IsRejected);
        Assert.Equal(503, e.Status);
    }

    [Fact(Timeout = 10000)]
    public async Task Column_types_are_read_as_numbers_or_names()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var table = await client.CreateTableAsync(FakeOptiCloud.Account, "T", "T", "");
        await client.AddColumnAsync(table.Id, new ColumnSpec("A", "A", ColumnType.DateTime));
        await client.AddColumnAsync(table.Id, new ColumnSpec("B", "B", ColumnType.Int));

        var columns = await client.GetColumnsAsync(table.Id);

        Assert.Equal([ColumnType.DateTime, ColumnType.Int], columns.Select(c => c.Type));
    }
}
