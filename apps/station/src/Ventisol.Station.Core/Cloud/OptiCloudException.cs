namespace Ventisol.Station.Core.Cloud;

// Everything that goes wrong talking to OptiCloud. The message is Danish and short: the setup
// screen and the menu show it as it is.
// Rejected: the server refused this very request (bad data, a duplicate). Sending it again as it
// is won't help. Auth: the login failed or the user may not do it (401, 403): that is the setup,
// not the scan, so nothing will work until it is fixed. Neither: the network or the server, worth
// trying again.
public sealed class OptiCloudException(string message, int? status = null, bool rejected = false, bool auth = false) : Exception(message)
{
    public int? Status { get; } = status;
    public bool IsRejected { get; } = rejected;
    public bool IsAuth { get; } = auth;

    // The password login itself failed. Only the login answer says BadLogin.
    public bool IsBadLogin => IsAuth && Message == BadLogin;

    // How long to wait before trying again, when the one who failed knows (OptiCloudClient after
    // a wrong password: what is left of the wait since the login that failed). Null: the usual backoff.
    public TimeSpan? RetryAfter { get; init; }

    public const string Unreachable = "Kan ikke nå OptiCloud";
    public const string BadLogin = "Forkert brugernavn eller adgangskode";
    public const string Unexpected = "Uventet svar fra OptiCloud";
    public const string Forbidden = "OptiCloud afviser brugeren (adgang)";

    // 401 and 403 are about the user, 408 and 429 mean later: everything else in the 400s is about the request.
    public static bool IsRejectedStatus(int status) => status is >= 400 and < 500 and not (401 or 403 or 408 or 429);
}
