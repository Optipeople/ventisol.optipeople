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

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());
        Assert.False(client.IsLoggedIn);
        // Nothing said the password was wrong.
        Assert.Equal(OptiCloudException.Unexpected, e.Message);
        Assert.False(e.IsBadLogin);
    }

    [Fact(Timeout = 10000)]
    public async Task A_login_page_in_the_way_is_not_a_wrong_password()
    {
        // A guest network's login page: a 200 with HTML, whatever was asked for.
        var api = new FakeOptiCloud
        {
            Override = (_, _, _) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<html><body>Log på netværket</body></html>", System.Text.Encoding.UTF8, "text/html") },
        };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());

        Assert.Equal(OptiCloudException.Unexpected, e.Message);
        Assert.False(e.IsBadLogin || e.IsAuth || e.IsRejected);
        // The usual short wait, and the next try does ask again.
        Assert.Equal(Outbox.Backoff[0], Outbox.Wait(e, 0));
        await Assert.ThrowsAsync<OptiCloudException>(() => client.GetCurrentUserAsync());
        Assert.Equal(2, api.Count("login"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_wrong_password_is_sent_once_in_a_quarter_of_an_hour_however_many_ask()
    {
        var api = new FakeOptiCloud();
        var now = new DateTimeOffset(2026, 11, 11, 8, 0, 0, TimeSpan.Zero);
        using var client = new OptiCloudClient("https://fake.opticloud.test", FakeOptiCloud.User, "forkert", api) { Clock = () => now };

        var first = await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());
        Assert.Null(first.RetryAfter);
        Assert.Equal(Outbox.LoginBackoff, Outbox.Wait(first, 0));

        // The loops and the machines each come by on their own timer: none of them gets through.
        now += TimeSpan.FromMinutes(5);
        Task Ask(int i) => (i % 3) switch
        {
            0 => client.LoginAsync(),
            1 => client.GetCurrentUserAsync(),
            _ => client.GetCurrentOrderAsync(Guid.NewGuid()),
        };
        var all = await Task.WhenAll(Enumerable.Range(0, 9).Select(i => Assert.ThrowsAsync<OptiCloudException>(() => Ask(i))));
        Assert.All(all, e => Assert.True(e.IsBadLogin));
        Assert.Equal(1, api.LoginCount("\"password\""));
        Assert.Single(api.Requests);
        // Each is told what is left of the wait, so they all come back together.
        Assert.All(all, e => Assert.Equal(TimeSpan.FromMinutes(10), Outbox.Wait(e, 3)));

        now += TimeSpan.FromMinutes(10) - TimeSpan.FromSeconds(1);
        await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());
        Assert.Equal(1, api.LoginCount("\"password\""));

        // The quarter of an hour is over: one more try, and again only one.
        now += TimeSpan.FromSeconds(1);
        await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());
        await Assert.ThrowsAsync<OptiCloudException>(() => client.GetCurrentUserAsync());
        Assert.Equal(2, api.LoginCount("\"password\""));
    }

    [Fact(Timeout = 10000)]
    public async Task A_new_client_with_the_right_password_does_not_wait()
    {
        var api = new FakeOptiCloud();
        var now = new DateTimeOffset(2026, 11, 11, 8, 0, 0, TimeSpan.Zero);
        using var wrong = new OptiCloudClient("https://fake.opticloud.test", FakeOptiCloud.User, "forkert", api) { Clock = () => now };
        await Assert.ThrowsAsync<OptiCloudException>(() => wrong.LoginAsync());

        // The setup was saved with the right password: CloudSync makes a new client.
        using var right = new OptiCloudClient("https://fake.opticloud.test", FakeOptiCloud.User, FakeOptiCloud.Password, api) { Clock = () => now };
        await right.LoginAsync();

        Assert.True(right.IsLoggedIn);
    }

    [Fact(Timeout = 10000)]
    public async Task A_password_put_right_in_opticloud_works_once_the_wait_is_over()
    {
        var wrong = true;
        var api = new FakeOptiCloud
        {
            Override = (_, path, _) => wrong && path.Contains("login") ? FakeOptiCloud.Json(new { errors = new[] { new { title = "Login", message = "Invalid credentials" } } }) : null,
        };
        var now = new DateTimeOffset(2026, 11, 11, 8, 0, 0, TimeSpan.Zero);
        using var client = new OptiCloudClient("https://fake.opticloud.test", FakeOptiCloud.User, FakeOptiCloud.Password, api) { Clock = () => now };
        await Assert.ThrowsAsync<OptiCloudException>(() => client.LoginAsync());

        wrong = false;
        now += Outbox.LoginBackoff;
        var user = await client.GetCurrentUserAsync();

        Assert.Equal(FakeOptiCloud.Account, user.AccountId);
    }

    [Theory(Timeout = 10000)]
    [InlineData(true)]
    [InlineData(false)]
    public async Task An_answer_with_no_data_about_a_machines_order_is_not_known_not_no_order(bool dataIsNull)
    {
        var api = new FakeOptiCloud
        {
            Override = (_, path, _) => !path.Contains("GetCurrentOrderActiveByMachineId") ? null
                : dataIsNull ? FakeOptiCloud.Json(new { data = (object?)null, errors = Array.Empty<object>() })
                : FakeOptiCloud.Json(new { errors = Array.Empty<object>() }),
        };
        using var client = api.Client();

        Assert.Null(await client.GetCurrentOrderAsync(Guid.NewGuid()));
    }

    [Fact(Timeout = 10000)]
    public async Task Data_that_is_no_object_about_a_machines_order_is_an_error()
    {
        var api = new FakeOptiCloud
        {
            Override = (_, path, _) => path.Contains("GetCurrentOrderActiveByMachineId") ? FakeOptiCloud.Json(new { data = "hm", errors = Array.Empty<object>() }) : null,
        };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.GetCurrentOrderAsync(Guid.NewGuid()));

        Assert.Equal(OptiCloudException.Unexpected, e.Message);
        Assert.False(e.IsRejected || e.IsAuth);
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
        Assert.True(e.IsAuth);
        Assert.Equal(2, api.Count("GetCurrentUser"));
    }

    [Theory(Timeout = 10000)]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_403_is_about_the_user_not_the_request(bool withErrors)
    {
        var api = new FakeOptiCloud
        {
            Override = (_, path, _) => !path.Contains("CreateRow") ? null
                : withErrors ? FakeOptiCloud.Json(new { errors = new[] { new { title = "Forbidden", message = "Nej" } } }, HttpStatusCode.Forbidden)
                : new HttpResponseMessage(HttpStatusCode.Forbidden),
        };
        using var client = api.Client();

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => client.CreateRowAsync(Guid.NewGuid(), new Dictionary<string, object?>()));

        Assert.Equal(OptiCloudException.Forbidden, e.Message);
        Assert.True(e.IsAuth);
        Assert.False(e.IsRejected || e.IsBadLogin);
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
