namespace Ventisol.Station.Core.Cloud;

// Everything that goes wrong talking to OptiCloud. The message is Danish and short: the setup
// screen and the menu show it as it is.
// Rejected: the server refused this very request (bad data, a duplicate). Sending it again as it
// is won't help. Auth: the login itself failed, so nothing will work until the setup is fixed.
// Neither: the network or the server, worth trying again.
public sealed class OptiCloudException(string message, int? status = null, bool rejected = false, bool auth = false) : Exception(message)
{
    public int? Status { get; } = status;
    public bool IsRejected { get; } = rejected;
    public bool IsAuth { get; } = auth;

    public const string Unreachable = "Kan ikke nå OptiCloud";
    public const string BadLogin = "Forkert brugernavn eller adgangskode";
    public const string Unexpected = "Uventet svar fra OptiCloud";

    // 401 is a login matter, 408 and 429 mean later: everything else in the 400s is about the request.
    public static bool IsRejectedStatus(int status) => status is >= 400 and < 500 and not (401 or 408 or 429);
}
