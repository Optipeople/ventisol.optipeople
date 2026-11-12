using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.ViewModels;

// How far a check against OptiCloud has come, for the dot and text beside its button.
public enum SetupStatus { None, Busy, Ok, Error }

// A line in a dropdown. Id null is "none".
public sealed record MachineOption(Guid? Id, string Name)
{
    public override string ToString() => Name;
}

public sealed record ScannerOption(string? Id, string Label)
{
    public override string ToString() => Label;
}

// The setup screen: edits a copy of the settings and hands it back on "Gem", or drops it on "Annuller".
// It never talks to OptiCloud or the scanners itself: the owner passes in how to test the connection,
// fetch the account's machines and list the connected scanners, and feeds it scans with OnRawScan.
// The saved password only ever goes to the address and user it was saved for: change either, and it
// has to be typed again before anything is tested, fetched or saved. Otherwise anyone at the screen
// could point the app at their own server and be sent the password.
public sealed partial class SetupViewModel : ObservableObject
{
    public const string ConnectionFailed = "Kunne ikke forbinde til OptiCloud";

    readonly Func<StationSettings, string, CancellationToken, Task<string?>> _testConnection;
    readonly Func<StationSettings, string, CancellationToken, Task<IReadOnlyList<(Guid Id, string Name)>>> _loadMachines;
    readonly Func<IReadOnlyCollection<string>> _connectedScanners;
    readonly Func<string, string?>? _scannerPort;
    readonly Func<string, CancellationToken, Task<OrderDocumentFolderStatus>> _checkDocumentsFolder;
    CancellationTokenSource? _documentsCheck;
    readonly SynchronizationContext? _ui = SynchronizationContext.Current;
    readonly int _uiThread = Environment.CurrentManagedThreadId;
    readonly CancellationTokenSource _closing = new();
    readonly string? _savedPassword;
    // The address and user the saved password belongs to.
    readonly string _savedApiUrl, _savedUsername;
    readonly Dictionary<Guid, string> _machineNames = [];
    bool _ready, _rebuilding, _closed;

    // A Zebra cradle in its default USB keyboard mode, for trying a scanner at a desk.
    // Always offered, plugged in or not.
    public const string KeyboardScannerId = "keyboard";
    public const string KeyboardScannerLabel = "Tastatur-scanner (USB HID)";

    // savedPassword is the one SettingsStore holds now (null if none). It is only used to test and fetch
    // until a new one is typed, only against the saved address and user, and is never handed back. scannerPort gives the COM port a connected
    // scanner is on, for its label. checkDocumentsFolder looks through a documents folder for the
    // status line under it (OrderDocumentLocator.CheckFolderAsync unless given).
    public SetupViewModel(
        StationSettings settings,
        string? savedPassword,
        Func<StationSettings, string, CancellationToken, Task<string?>> testConnection,
        Func<StationSettings, string, CancellationToken, Task<IReadOnlyList<(Guid Id, string Name)>>> loadMachines,
        Func<IReadOnlyCollection<string>> connectedScanners,
        Func<string, string?>? scannerPort = null,
        Func<string, CancellationToken, Task<OrderDocumentFolderStatus>>? checkDocumentsFolder = null)
    {
        _testConnection = testConnection;
        _loadMachines = loadMachines;
        _connectedScanners = connectedScanners;
        _scannerPort = scannerPort;
        _checkDocumentsFolder = checkDocumentsFolder ?? ((folder, ct) => OrderDocumentLocator.CheckFolderAsync(folder, ct: ct));
        _savedPassword = string.IsNullOrEmpty(savedPassword) ? null : savedPassword;

        settings = StationSettingsJson.Normalize(settings);
        _savedApiUrl = UrlKey(settings.ApiBaseUrl);
        _savedUsername = (settings.Username ?? "").Trim();
        Stations = [.. settings.Stations.Select(s => new SetupStationViewModel(this, s))];
        Mode = settings.Mode;
        ApiBaseUrl = settings.ApiBaseUrl;
        Username = settings.Username ?? "";
        AccountIdText = settings.AccountId?.ToString() ?? "";
        DocumentsFolder = settings.DocumentsFolder ?? "";

        _ready = true;
        RebuildMachines();
        RebuildScanners();
        UpdateProblems();
    }

    // Writes what "Gem" hands over: the settings, the password (null to keep the saved one, "" to forget
    // it, else the new one) and the setup PIN (null to keep it, "" to remove it, else the new one).
    // False when it could not be written: the screen then stays open and says so. Not set: nothing to write.
    public Func<StationSettings, string?, string?, bool>? Persist { get; init; }

    // Raised after Persist went well, with the settings and the password as given to it.
    public event Action<StationSettings, string?>? Saved;
    public event Action? Cancelled;

    public IReadOnlyList<SetupStationViewModel> Stations { get; }
    public ObservableCollection<MachineOption> Machines { get; } = [];
    public ObservableCollection<ScannerOption> Scanners { get; } = [];

    // ----- Skærmens rolle

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsScanMode), nameof(IsViewerMode))]
    public partial StationMode Mode { get; set; }

    public bool IsScanMode { get => Mode == StationMode.Scan; set { if (value) Mode = StationMode.Scan; } }
    public bool IsViewerMode { get => Mode == StationMode.Viewer; set { if (value) Mode = StationMode.Viewer; } }

    // ----- OptiCloud

    [ObservableProperty] public partial string ApiBaseUrl { get; set; } = "";
    [ObservableProperty] public partial string Username { get; set; } = "";
    [ObservableProperty] public partial string AccountIdText { get; set; } = "";

    // Set from the PasswordBox as it is typed. Never shown, never handed back unless saved.
    string _password = "";
    public string Password
    {
        get => _password;
        set
        {
            if (_password == value) return;
            _password = value ?? "";
            if (_password.Length > 0) ForgetSaved = false;
            OnPropertyChanged(nameof(PasswordHint));
            ResetConnection();
            ClearRetype();
            UpdateProblems();
        }
    }

    public bool HasSavedPassword => _savedPassword is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PasswordHint), nameof(CanForgetPassword))]
    public partial bool ForgetSaved { get; private set; }

    public bool CanForgetPassword => HasSavedPassword && !ForgetSaved;

    // The address or the user is not the one the saved password was saved for.
    bool LoginChanged => !string.Equals(UrlKey(ApiBaseUrl), _savedApiUrl, StringComparison.OrdinalIgnoreCase)
                         || !string.Equals((Username ?? "").Trim(), _savedUsername, StringComparison.Ordinal);

    // The saved password can't be used for what the form says now, and no other has been typed.
    bool MustRetypePassword => HasSavedPassword && LoginChanged && !ForgetSaved && Password.Length == 0;

    static string UrlKey(string? url) => (url ?? "").Trim().TrimEnd('/');

    // Shown in the empty password box.
    public string PasswordHint =>
        ForgetSaved ? "Glemmes, når du gemmer"
        : !HasSavedPassword ? ""
        : LoginChanged ? "Skriv adgangskoden igen"
        : "Gemt · skriv en ny for at skifte";

    partial void OnForgetSavedChanged(bool value) => UpdateProblems();

    // ----- PIN-kode

    // True when a setup PIN is set now.
    public bool HasPin { get; init; }

    // Typed in the PIN box: blank leaves the PIN as it is.
    [ObservableProperty]
    public partial string NewPin { get; set; } = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PinHint), nameof(CanRemovePin))]
    public partial bool RemovePin { get; private set; }

    public bool CanRemovePin => HasPin && !RemovePin;

    // Shown in the empty PIN box.
    public string PinHint => RemovePin ? "Fjernes, når du gemmer" : HasPin ? "Sat · skriv en ny for at skifte" : "Ingen · 4 til 8 cifre";

    partial void OnNewPinChanged(string value)
    {
        if (value.Length > 0) RemovePin = false;
        UpdateProblems();
    }

    // What stopped the last "Gem" from being written, or null.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Notice))]
    public partial string? SaveError { get; private set; }

    // The line beside "Gem": why the last save failed, else the first thing that stops a save.
    public string? Notice => SaveError ?? Problem;

    [ObservableProperty] public partial SetupStatus ConnectionStatus { get; private set; }
    [ObservableProperty] public partial string ConnectionText { get; private set; } = "";

    [ObservableProperty] public partial SetupStatus MachinesStatus { get; private set; }
    [ObservableProperty] public partial string MachinesText { get; private set; } = "";

    // ----- Ordredokumenter

    // Where 3E puts the order PDFs. Blank turns the order documents off.
    [ObservableProperty] public partial string DocumentsFolder { get; set; } = "";
    [ObservableProperty] public partial SetupStatus DocumentsStatus { get; private set; }
    [ObservableProperty] public partial string DocumentsText { get; private set; } = "";

    partial void OnDocumentsFolderChanged(string value)
    {
        if (_ready) CheckDocumentsFolder(TimeSpan.FromMilliseconds(600));
    }

    // ----- Gem

    // The first thing that stops a save, or null.
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand))]
    [NotifyPropertyChangedFor(nameof(Notice))]
    public partial string? Problem { get; private set; }

    partial void OnApiBaseUrlChanged(string value) { OnPropertyChanged(nameof(PasswordHint)); ResetConnection(); ClearRetype(); UpdateProblems(); }
    partial void OnUsernameChanged(string value) { OnPropertyChanged(nameof(PasswordHint)); ResetConnection(); ClearRetype(); UpdateProblems(); }
    partial void OnAccountIdTextChanged(string value) { ResetConnection(); UpdateProblems(); }

    // Opening the screen: fresh scanner list, and the machine names if it can already log in.
    public void Activate()
    {
        RebuildScanners();
        CheckDocumentsFolder(TimeSpan.Zero);
        if (MachinesStatus != SetupStatus.Ok && CurrentPassword() is not null && TryBuild(out var s) && s.IsConnected)
            _ = LoadMachinesCore(quiet: true);
    }

    // The owner calls this when a scanner is plugged in or out while the screen is open.
    public void RefreshScanners() => OnUi(() => RebuildScanners());

    // Every scan while the screen is open, from any thread. With a station waiting in "Identificér",
    // the scanner that sent it becomes that station's scanner.
    public void OnRawScan(RawScan scan) => OnUi(() =>
    {
        if (_closed || string.IsNullOrWhiteSpace(scan.ScannerId)) return;
        var id = scan.ScannerId.Trim();
        if (!Scanners.Any(o => string.Equals(o.Id, id, StringComparison.OrdinalIgnoreCase) && !o.Label.EndsWith(NotConnected)))
            RebuildScanners(extra: id);

        var waiting = Stations.FirstOrDefault(s => s.IsIdentifying);
        if (waiting is null) return;
        waiting.IsIdentifying = false;
        waiting.Scanner = Scanners.First(o => string.Equals(o.Id, id, StringComparison.OrdinalIgnoreCase));
        waiting.Note = $"{waiting.Scanner.Label} er sat på {waiting.DisplayName}";
    });

    // ----- Commands

    [RelayCommand]
    async Task TestConnection()
    {
        if (!Ready(out var settings, out var password, s => (ConnectionStatus, ConnectionText) = (SetupStatus.Error, s))) return;
        ConnectionStatus = SetupStatus.Busy;
        ConnectionText = "Forbinder …";
        string? error;
        try { error = await _testConnection(settings, password, _closing.Token); }
        catch (OperationCanceledException) { return; }
        catch { error = ConnectionFailed; }
        if (_closed) return;
        (ConnectionStatus, ConnectionText) = error is null ? (SetupStatus.Ok, "Forbundet") : (SetupStatus.Error, error);
    }

    [RelayCommand]
    Task LoadMachines() => LoadMachinesCore(quiet: false);

    [RelayCommand]
    void UpdateScanners() => RebuildScanners();

    [RelayCommand]
    void ForgetPassword()
    {
        ForgetSaved = true;
        ResetConnection();
    }

    [RelayCommand]
    void ForgetPin()
    {
        NewPin = "";
        RemovePin = true;
    }

    [RelayCommand(CanExecute = nameof(CanSave))]
    void Save()
    {
        if (!TryBuild(out var settings) || _closed || Problem is not null) return;
        // A saved password is never kept for another address or user (Problem stops that; this is the belt).
        string? newPassword = Password.Length > 0 ? Password : ForgetSaved || LoginChanged && HasSavedPassword ? "" : null;
        string? newPin = NewPin.Length > 0 ? NewPin : RemovePin ? "" : null;
        settings = StationSettingsJson.Normalize(settings);

        SaveError = null;
        bool written;
        try { written = Persist?.Invoke(settings, newPassword, newPin) ?? true; }
        catch { written = false; }
        if (!written)
        {
            // Stay open with everything as typed, so it can be tried again.
            SaveError = "Kunne ikke gemme. Prøv igen.";
            return;
        }
        Close();
        Saved?.Invoke(settings, newPassword);
    }

    bool CanSave() => Problem is null;

    [RelayCommand]
    void Cancel()
    {
        if (_closed) return;
        Close();
        Cancelled?.Invoke();
    }

    // ----- For the station rows

    internal void ScannerChosen(SetupStationViewModel row)
    {
        if (_rebuilding || row.Scanner?.Id is not { } id) { UpdateProblems(); return; }
        foreach (var other in Stations.Where(s => s != row && s.Scanner?.Id == id))
            other.Scanner = Scanners[0];
        UpdateProblems();
    }

    internal void Identify(SetupStationViewModel row)
    {
        var start = !row.IsIdentifying;
        foreach (var s in Stations) { s.IsIdentifying = false; s.Note = null; }
        if (!start) return;
        RebuildScanners();
        row.IsIdentifying = true;
        row.Note = $"Scan en stregkode med scanneren til {row.DisplayName}";
    }

    internal void Changed() => UpdateProblems();

    // ----- Inside

    async Task LoadMachinesCore(bool quiet)
    {
        if (!Ready(out var settings, out var password, s => (MachinesStatus, MachinesText) = (SetupStatus.Error, s))) return;
        MachinesStatus = SetupStatus.Busy;
        MachinesText = "Henter maskiner …";
        IReadOnlyList<(Guid Id, string Name)> machines;
        try { machines = await _loadMachines(settings, password, _closing.Token); }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            if (_closed) return;
            var why = ex is Core.Cloud.OptiCloudException ? $": {ex.Message}" : "";
            (MachinesStatus, MachinesText) = quiet ? (SetupStatus.None, "") : (SetupStatus.Error, $"Kunne ikke hente maskinerne{why}");
            return;
        }
        if (_closed) return;

        _machineNames.Clear();
        foreach (var (id, name) in machines) _machineNames[id] = string.IsNullOrWhiteSpace(name) ? id.ToString() : name.Trim();
        RebuildMachines();
        MachinesStatus = SetupStatus.Ok;
        MachinesText = machines.Count switch { 0 => "Ingen maskiner på kontoen", 1 => "1 maskine hentet", var n => $"{n} maskiner hentet" };
    }

    // Looks through the folder after a pause in the typing, and says what it found. Only the
    // latest check answers; a slow share never holds up the screen.
    async void CheckDocumentsFolder(TimeSpan delay)
    {
        _documentsCheck?.Cancel();
        var folder = StationSettingsJson.NormalizeFolder(DocumentsFolder);
        if (folder is null || _closed)
        {
            (DocumentsStatus, DocumentsText) = (SetupStatus.None, "");
            return;
        }

        var cts = CancellationTokenSource.CreateLinkedTokenSource(_closing.Token);
        _documentsCheck = cts;
        DocumentsStatus = SetupStatus.Busy;
        DocumentsText = "Kigger i mappen …";
        OrderDocumentFolderStatus result;
        try
        {
            if (delay > TimeSpan.Zero) await Task.Delay(delay, cts.Token);
            result = await _checkDocumentsFolder(folder, cts.Token);
        }
        catch (OperationCanceledException) { return; }
        catch { result = new OrderDocumentFolderStatus(false, 0, 0); }
        if (_closed || cts.IsCancellationRequested) return;

        (DocumentsStatus, DocumentsText) = result switch
        {
            { Available: false } => (SetupStatus.Error, result.Error is { Length: > 0 } why ? why : "Mappen kan ikke læses"),
            { Orders: 0 } => (SetupStatus.Error, "Ingen ordredokumenter i mappen"),
            { Orders: 1 } => (SetupStatus.Ok, "Fundet 1 ordre"),
            _ => (SetupStatus.Ok, $"Fundet {result.Orders} ordrer"),
        };
    }

    // The form as settings plus the password to use, or false with the reason given to fail.
    bool Ready(out StationSettings settings, out string password, Action<string> fail)
    {
        password = "";
        if (!TryBuild(out settings)) { fail("Konto-id ser ikke rigtigt ud"); return false; }
        if (SetupRules.ApiUrlProblem(settings.ApiBaseUrl) is { } url) { fail(url == SetupRules.HttpsOnly ? url : "API-adressen skal være en webadresse"); return false; }
        if (settings.Username is null) { fail("Skriv brugernavnet"); return false; }
        if (settings.AccountId is null) { fail("Skriv konto-id"); return false; }
        if (CurrentPassword() is not { } p) { fail(MustRetypePassword ? RetypePassword : "Skriv adgangskoden"); return false; }
        password = p;
        return true;
    }

    const string RetypePassword = "Skriv adgangskoden igen: adressen eller brugernavnet er ændret";

    // The password to log in with now. The saved one only for the address and user it was saved for.
    string? CurrentPassword() => Password.Length > 0 ? Password : ForgetSaved || LoginChanged ? null : _savedPassword;

    bool TryBuild(out StationSettings settings)
    {
        var ok = SetupRules.TryParseAccountId(AccountIdText, out var account);
        settings = new StationSettings(
            Mode,
            ApiBaseUrl.Trim(),
            account,
            string.IsNullOrWhiteSpace(Username) ? null : Username.Trim(),
            [.. Stations.Select(s => s.ToSetup())],
            StationSettingsJson.NormalizeFolder(DocumentsFolder));
        return ok;
    }

    void UpdateProblems()
    {
        if (!_ready) return;
        var ok = TryBuild(out var s);
        Problem = !ok ? "Konto-id ser ikke rigtigt ud"
            : SetupRules.Problems(s).FirstOrDefault()
              ?? (MustRetypePassword ? RetypePassword + " (eller tryk Glem)"
                  : NewPin.Length > 0 && !SetupPin.IsValid(NewPin) ? $"PIN skal være {SetupPin.MinDigits} til {SetupPin.MaxDigits} cifre"
                  : null);
        // A new problem is the line to show now, not an old failed save.
        if (Problem is not null) SaveError = null;
    }

    // "Skriv adgangskoden igen" beside "Hent maskiner" goes when it no longer holds: the address and
    // the user are back to the saved ones, or a password has been typed.
    void ClearRetype()
    {
        if (MachinesStatus != SetupStatus.Error || MachinesText != RetypePassword || MustRetypePassword) return;
        (MachinesStatus, MachinesText) = (SetupStatus.None, "");
    }

    void ResetConnection()
    {
        if (ConnectionStatus == SetupStatus.Busy) return;
        ConnectionStatus = SetupStatus.None;
        ConnectionText = "";
    }

    // Machines from the account, by name, plus any a station already points at that isn't among them.
    void RebuildMachines()
    {
        var chosen = Stations.Select(s => s.Machine is null ? s.InitialMachineId : s.Machine.Id).ToList();
        var options = new List<MachineOption> { new(null, "Ingen maskine") };
        options.AddRange(_machineNames.OrderBy(m => m.Value, StringComparer.CurrentCultureIgnoreCase).Select(m => new MachineOption(m.Key, m.Value)));
        foreach (var id in chosen.OfType<Guid>().Distinct().Where(id => !_machineNames.ContainsKey(id)))
            options.Add(new MachineOption(id, _machineNames.Count > 0 ? $"Ukendt maskine · {Short(id)}" : $"Gemt maskine · {Short(id)}"));

        Replace(Machines, options, () =>
        {
            for (var i = 0; i < Stations.Count; i++)
                Stations[i].Machine = Machines.First(m => m.Id == chosen[i]);
        });
    }

    // Connected scanners, plus any a station already has that isn't plugged in right now.
    void RebuildScanners(string? extra = null)
    {
        var chosen = Stations.Select(s => s.Scanner is null ? s.InitialScanner : s.Scanner.Id).ToList();
        IReadOnlyCollection<string> connected;
        try { connected = _connectedScanners(); }
        catch { connected = []; }

        var ids = connected.Where(c => !string.IsNullOrWhiteSpace(c)).Select(c => c.Trim()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (extra is not null) ids.Add(extra);
        ids.Remove(KeyboardScannerId);
        var options = new List<ScannerOption> { new(null, "Ingen scanner") };
        options.AddRange(ids.Select(id => new ScannerOption(id, UsbPort.Label(id, PortOf(id))))
            .OrderBy(o => o.Label, StringComparer.OrdinalIgnoreCase));
        options.Add(new ScannerOption(KeyboardScannerId, KeyboardScannerLabel));
        foreach (var id in chosen.OfType<string>().Distinct(StringComparer.OrdinalIgnoreCase)
                     .Where(id => !ids.Contains(id) && !string.Equals(id, KeyboardScannerId, StringComparison.OrdinalIgnoreCase)))
            options.Add(new ScannerOption(id, UsbPort.Label(id) + NotConnected));

        Replace(Scanners, options, () =>
        {
            for (var i = 0; i < Stations.Count; i++)
                Stations[i].Scanner = Scanners.FirstOrDefault(o => string.Equals(o.Id, chosen[i], StringComparison.OrdinalIgnoreCase)) ?? Scanners[0];
        });
    }

    // Swap the items, then put every station's choice back: a dropdown drops its choice when its item goes.
    void Replace<T>(ObservableCollection<T> target, List<T> items, Action restore)
    {
        _rebuilding = true;
        try
        {
            target.Clear();
            foreach (var item in items) target.Add(item);
            restore();
        }
        finally { _rebuilding = false; }
        UpdateProblems();
    }

    const string NotConnected = " · ikke tilsluttet";

    string? PortOf(string id)
    {
        try { return _scannerPort?.Invoke(id); }
        catch { return null; }
    }

    static string Short(Guid id) => id.ToString()[..8];

    void Close()
    {
        _closed = true;
        foreach (var s in Stations) s.IsIdentifying = false;
        _closing.Cancel();
    }

    void OnUi(Action a)
    {
        if (_ui is null || Environment.CurrentManagedThreadId == _uiThread) a();
        else _ui.Post(_ => a(), null);
    }
}

// One station's line on the setup screen.
public sealed partial class SetupStationViewModel : ObservableObject
{
    readonly SetupViewModel _owner;

    internal SetupStationViewModel(SetupViewModel owner, StationSetup s)
    {
        _owner = owner;
        Number = s.Number;
        Name = s.Name;
        Kind = s.Kind;
        InitialMachineId = s.MachineId;
        InitialScanner = s.ScannerSerial;
    }

    public int Number { get; }
    internal Guid? InitialMachineId { get; }
    internal string? InitialScanner { get; }

    public SetupViewModel Owner => _owner;
    public string DisplayName => string.IsNullOrWhiteSpace(Name) ? $"station {Number}" : Name.Trim();

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(DisplayName))]
    public partial string Name { get; set; } = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsAssembly), nameof(IsPacking))]
    public partial StationKind Kind { get; set; }

    public bool IsAssembly { get => Kind == StationKind.Assembly; set { if (value) Kind = StationKind.Assembly; } }
    public bool IsPacking { get => Kind == StationKind.Packing; set { if (value) Kind = StationKind.Packing; } }

    [ObservableProperty] public partial MachineOption? Machine { get; set; }
    [ObservableProperty] public partial ScannerOption? Scanner { get; set; }

    [ObservableProperty] public partial bool IsIdentifying { get; internal set; }

    // A line under the row: what to do while identifying, or what it found.
    [ObservableProperty] public partial string? Note { get; internal set; }

    partial void OnNameChanged(string value) => _owner.Changed();
    partial void OnScannerChanged(ScannerOption? value) => _owner.ScannerChosen(this);

    [RelayCommand]
    void Identify() => _owner.Identify(this);

    public StationSetup ToSetup() =>
        new(Number, Name.Trim(), Kind, Machine is null ? InitialMachineId : Machine.Id, Scanner is null ? InitialScanner : Scanner.Id);
}
