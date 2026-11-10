# Orders on machines in OptiCloud

What the OptiPeople API offers for running an order on a machine, so a scan at a Ventisol station
can start the order in OptiCloud on the station's machine and end it again.

Sources:

- New swagger: `context/optipeople-swagger.json` (OpenAPI 3.0.4, 790 paths). Old: `docs/api/optipeople.swagger.json` (3.0.1, 749 paths).
- The swagger has no enum names and no response schemas: nearly every response is
  `ResponseViewModel { data: any, errors: [{title, message}], meta: any }`. Enum names and the
  meaning of calls below come from the OptiPeople backoffice source
  (`optipeople.backoffice`, the "Order / unit information" dashboard widget) and the OptiCloud
  External API Reference PDF (`optipeople.vola/docs/api-doc.txt`). Where a point is inferred, it says so.
- All bodies are sent as `application/json` (the swagger lists `application/json;odata.metadata=minimal;odata.streaming=true`).

## The model

OptiCloud calls an order a **part order number** (UI: "unit information"). Three entities:

| Entity | What it is | Key fields |
|---|---|---|
| `PartOrderNumber` | The order itself, **per factory**, not per machine | `id`, `number` (string), `factoryId`, `identifierType`, `status`, `completedDate`, custom fields |
| `PartInformation` | **One run of an order on one machine** | `id`, `machineId`, `partOrderNumberId`, `startDateTime`, `endDateTime` |
| `MachinePartInformation` | Planning defaults for an order on a machine | `machineId`, `partOrderNumberId`, `expectedSpeed`, `totalAmountToProduce` |

Enums (names from the backoffice):

| Enum | Values |
|---|---|
| `PartOrderNumberIdentifierType` | 0 Batch, 1 PartNo, 2 OrderNo |
| `PartInformationStatus` | 0 Active, 1 Complete |
| `PartOrderNumberStatusFilter` (new) | 0, 1, 2. Names not in the source; most likely All, Active, Complete |
| `CustomFieldType` | 0 text, 1 textArea, 2 image, 3 link |

So:

- **One order on several machines at once** is one `PartOrderNumber` with one `PartInformation`
  per machine, each with its own start and end. `DataExport/GetOrderReportExport` returns "one
  entry per part order on each machine". This fits Ventisol: order 58556 can run at Station 10
  and Station 20 at the same time.
- **One machine runs one order at a time.** A machine has a single "current order"
  (`GetCurrentOrderActiveByMachineId`, `Report/CurrentUnitInformation`, `Machine.currentOPNumber`).
  Setting a new order on a machine ends the run of the previous one (inferred: the widget never
  stops the old order before starting a new one). There is no way to run two orders on one machine.
- Produced and rejected counts, uptime, downtime and OEE are attributed to the order that is
  current on the machine while they happen.

## Start, stop and finish

| Action | Endpoint | Client time? |
|---|---|---|
| Start order X on machine M | `POST /api/RealtimeDashboard/SetOrderToMachine` `{machineId, number: "X"}` | **No**, server time |
| Stop the current order on M | same, with `number: ""` | **No**, server time |
| Start order X on M at a given time | `POST /api/Machine/SetMachinePartInformation` `{machineId, partInformationName: "X", timeOfOccurence}` | **Yes** |
| Mark the order complete (factory level) | `PUT /api/PartOrderNumber/Update` with `status: 1` | `completedDate` in body (not known if honoured) |
| Complete the current order of a device | `POST /incomacapp/api/Order/CompleteCurrentOrderByDeviceIoTHubId` `{deviceIoTHubId}` | No. Incomac app, needs an IoT device |

There are no separate pause or resume calls. "Pause" in OptiCloud is the machine state (running or
stopped, see below), not the order.

### `POST /api/RealtimeDashboard/SetOrderToMachine`

What the dashboard "Order" widget calls. Body is `PartOrderNumberDTO`, but the widget sends only:

```json
{ "machineId": "<uuid>", "number": "58556", "totalAmountToProduce": null, "expectedSpeed": null }
```

- `number` set: makes it the machine's current order and starts a `PartInformation` run now.
- `number: ""`: stops the current order (this is exactly what the widget's Stop button sends).
- The order does **not** have to exist. The widget looks the number up with `GetOrderNumber`; if
  nothing is found it still calls `SetOrderToMachine` as a "new order", so the server creates the
  `PartOrderNumber` in the machine's factory. Whether this is gated by the factory setting
  `isEnableOperatorPanelCreatePartInformation` ("enable create new part information") is not
  known.
- No time field. The start is the server's time when the call arrives.

### `POST /api/Machine/SetMachinePartInformation`

Also in the External API (`https://dataexport.optipeople.dk/api/...` with `Authorization: Opti <account code>`
or `?access_code=`), documented there as "Set part information for a machine". Body `SetMachinePartInfomationDTO`:

| Field | Type | Notes |
|---|---|---|
| `partInformationName` | string, nullable | the order number, e.g. `58556` |
| `machineId` | uuid, nullable | |
| `expectedSpeed` | int32, nullable | units per hour, for performance |
| `totalAmountToProduce` | int32, nullable | planned quantity |
| `timeOfOccurence` | date-time, nullable | "Time when the part order takes effect on the machine" |
| `customFields` | `[{name, value}]`, nullable | free name/value pairs |

Response `data` is an empty object on success. This is the only order call that takes a client
timestamp, so it is the one that suits our outbox (scans sent late after a network outage).
Not known: whether an empty `partInformationName` stops the order, whether a time in the past is
accepted and back-dates the run (and the end of the previous run), and whether it creates a missing
`PartOrderNumber`.

### Machine running state

| Endpoint | What |
|---|---|
| `PUT /api/Machine/UpdateStateMachineManual?machineId=&machineStart=true\|false` | Sets the machine running or stopped by hand. Server time |
| `PUT /api/OperatorPanelApp/UpdateStateMachineManual` | Same, from the operator panel app |
| `POST /api/IncomacApp/SetMachineState` `{machineId, state: string}` | Incomac app; values of `state` not documented |
| `GET /api/RealtimeDashboard/GetCurrentMachineState?machineId=` | Current state. The widget reads `data.machineRunningState` (0 = no active shift) |
| `GET /api/RealtimeDashboard/GetCurrentMachineStateContinuousDuration?machineId=` | How long in the current state |

Our stations have no IoT device, so OptiCloud gets no running signal for them. Order time is
still recorded (start to end of the `PartInformation`), but availability, performance and OEE need
the machine to be running and counting. That needs `UpdateStateMachineManual` and `AddUnitManual`
too, or shows zero.

## Creating and finding orders

| Method, path | Params / body | What |
|---|---|---|
| `POST /api/PartOrderNumber/Create` | `PartOrderNumberDTO` | Create an order in a factory |
| `POST /api/PartOrderNumber/SetPartOrder` | `PartOrderNumberDTO` | Create or update (inferred: upsert by number) |
| `POST /api/PartOrderNumber/ExternalSetPartOrder` | `{factoryId, partOrderNumber, customFields: [{text, label}]}` | External API: "Name or number of the part order to create or update" |
| `POST /incomacapp/api/Order/SetOrder` | same body as `ExternalSetPartOrder` | Incomac app copy |
| `PUT /api/PartOrderNumber/Update` | `PartOrderNumberDTO` | Change fields, set `status` Complete |
| `DELETE /api/PartOrderNumber/Delete?id=` | | |
| `PUT /api/PartOrderNumber/FixDuplicatePartOrderNumbers` | | Admin repair; duplicates of a number in a factory have happened |
| `GET /api/RealtimeDashboard/GetOrderNumber?machineId=&number=` | | Look an order up by number for a machine. `data` is an array; `data[0]` has `number`, `customFieldItems`, `items`, `expectedSpeed` |
| `GET /api/PartOrderNumber/GetByMachineIdAndNumber?machineId=&number=` | | Same lookup, PartOrderNumber controller |
| `GET /api/OperatorPanelApp/GetByMachineIdAndNumber?machineId=&number=` | | Same, operator panel app |
| `GET /api/RealtimeDashboard/GetOrderNumberByMachineId?machineId=` | | Orders offered for a machine (the widget's pick list); `data` is an array of `{number}` |
| `GET /api/PartOrderNumber/GetByMachineId?machineId=` | | Orders for a machine |
| `GET /api/PartOrderNumber/GetPartOrderNumberFactoryByMachineId?machineId=` | | Orders in the machine's factory |
| `GET /api/PartOrderNumber/GetByMachineIdForReport`, `GetPartOrderNumberFactoryByMachineIdForReport` | `machineId` | Report variants |
| `GET /api/OperatorPanelApp/GetAllPartOrderNumbers?machineId=` | | Operator panel list |
| `GET /api/PartOrderNumber/GetById?partOrderId=` | | One order |
| `GET /api/PartOrderNumber/GetByAccountId?accountId=` | | All orders in the account |
| `GET /api/PartOrderNumber/ExternalGetByFactoryId?factoryId=` | | External API: all orders in a factory |
| `GET /api/PartOrderNumber/GetByPage` | `Type` (identifier type), `FactoryId`, `Status` (new), `keyword`, `page`, `pageSize`, `Orderby`, `IsAscending` | Paged list; `data.partOrderNumbers[]` |
| `GET /api/PartOrderNumber/GetIdentifierType` | | The identifier type list |
| `GET /api/PartOrderNumber/GetOrderNumbersForTaskByAccountId?accountId=` | | For task custom fields |
| `GET /api/QualityControl/GetPartOrderNumberByOrderScanId/{machineId}/{orderScanId}` | | Order by a scanned id (QC) |

`PartOrderNumberDTO` (body of `Create`, `SetPartOrder`, `Update`, `SetOrderToMachine`):

| Field | Type | Notes |
|---|---|---|
| `id` | uuid, nullable | empty on create |
| `number` | string, nullable | the order number |
| `partOrderId` | uuid, nullable | |
| `machineId` | uuid, nullable | |
| `expectedSpeed` | int32, nullable | |
| `totalAmountToProduce` | int32, nullable | planned quantity |
| `factoryId` | uuid, **not nullable** | required in practice for create |
| `isDefaultPartInfo` | bool | |
| `identifierType` | `PartOrderNumberIdentifierType` | 2 = OrderNo for us |
| `status` | `PartInformationStatus` | 0 Active, 1 Complete |
| `completedDate` | date-time, nullable | |
| `completedDateString`, `typeName`, `updateDateString` | string, nullable | display only |
| `updateDate` | date-time | |
| `isCanDelete` | bool | |
| `customFieldItems` | `[{id, customFieldType, label, value1, value2, sortOrder, imageRefId}]` | |
| `machineOrderCustomFields` | `[{id, label, value}]` | |
| `machineOrderCustomFieldValues` | `[{label, value, partOrderNumberId, partOrderNumberName, machineOrderCustomFieldId}]` | |

No field is marked required in the swagger. There are no planned start or end times on an order:
OptiCloud has no order queue or production planning. "Planning" is only `MachinePartInformation`
(expected speed and quantity per machine).

### Per-machine planning defaults (`MachinePartInfomation`, sic)

| Method, path | Body / params |
|---|---|
| `POST /api/MachinePartInfomation/Create` | `{id, machineId, machineName, partInformationId, partInformationName, expectedSpeed, totalAmountToProduce}` |
| `PUT /api/MachinePartInfomation/Update` | same |
| `DELETE /api/MachinePartInfomation/Delete/{id}` | |
| `GET /api/MachinePartInfomation/GetMachinePartInfomations?machineId=` | |
| `GET /api/MachinePartInfomation/GetMachinePartInfomationList` | `machineId`, `keyword`, `page`, `pageSize`, `Orderby`, `IsAscending` |
| `POST /api/MachinePartInfomation/importUnitInfomation/{machineId}` | multipart `formFile` |
| `GET /api/MachinePartInfomation/ExportUnitInfomation/{machineId}` | file |

### Per-machine order custom fields

`MachineOrderCustomField/*` (`Create`, `Update`, `Delete/{id}`, `DeleteByMachineId/{machineId}`,
`Get/{id}`, `GetByMachineId/{machineId}`, `ToggleFeature/{machineId}?enabled=`) defines extra
fields a machine asks for per order; `PUT /api/Machine/UpdateMachineOrderCustomFieldValues`
`{machineId, machineOrderCustomFieldValues: [...]}` fills them. Could hold position, sub-position
or piece, but these belong to the order, not to a scan.

## Current order and counts

| Method, path | Params | What |
|---|---|---|
| `GET /api/RealtimeDashboard/GetCurrentOrderActiveByMachineId` | `machineId`, `resetTimerOnShiftBreaks` | Current order on the machine. `data.number` empty when none; `data.startDate` |
| `GET /api/Report/CurrentUnitInformation` | `machineId` | External API: `{partInfoId, partOrderNoId, partOrderNumber, identifierType, startTime, endTime, customFields}` |
| `GET /api/ItemScan/GetLatestForCurrentOrder/{accountId}/{machineId}` | | Latest item scan for the current order |
| `GET /api/RealtimeDashboard/GetPartCounterProducedByOrder/{machineId}/{internalName}` | `subtractRejected` | Produced on the current order |
| `GET /api/RealtimeDashboard/GetRejectedPartCounterByOrder/{machineId}/{internalName}` | | Rejected on the current order |
| `GET /api/PartOrderNumber/GetProducedUnitsByPartOrderAndCounter` | `machineId`, `partOrderNumberId`, `counterName` | Produced on an order |
| `GET /api/PartOrderNumber/ExternalGetUnitsProduced` | `machineId`, `counterName`, `from`, `to` | Units in a time range |
| `PUT /api/Machine/AddUnitManual` | `machineId`, `unit` (double), `internalName` | Add produced units by hand (server time) |
| `PUT /api/Machine/EditProducedUnitCounter` | body `{machineId, action, adjustment, internalName}` | Correct a counter |
| `GET /api/Machine/GetManualUnitCounterHistory` | | |

## History of orders on machines (for reports)

| Method, path | Params | What |
|---|---|---|
| `GET /api/DataExport/GetOrderReportExport` | `machineId` (repeat), `from`, `to` | One row per order per machine: `partInformationId`, `partOrderNumberId`, `partOrderName`, `startTime`, `endTime`, `shiftTimeInSeconds`, `totalDownTimeInSeconds`, `expectedSpeed`, `wasteInformation[]`, `counters[]` |
| `GET /api/PartOrderNumber/GetPartOrderTimeRangesByDates` | `machineId`, `from`, `to`, `sortField`, `ascending`, `pageNumber`, `pageSize`, `keyword` | Order runs on a machine by date |
| `GET /api/PartOrderNumber/GetPartOrderTimeRangesByWeeks` | `machineId`, `year`, `weekNumbers[]`, same paging | Same by week |
| `GET /api/Report/ExternalExportUnitInformation` | `machineId`, `startDate`, `endDate`, `from`, `to`, `showLatest` | Order runs, External API |
| `GET /api/Report/ExternalExportUnitInformationV2` | same without `showLatest` | With custom fields |

## Device path (IoT)

`POST /api/DeviceMessage/ProcessEvent` and `ProcessEventOmron` take device events with their own
timestamps (`functions[].timeStamp` / `time`) and carry `expectedSpeed`, `totalAmountToProduce` and
`customFields`, so a PLC can switch the order. They need a registered IoT device (`devHubId`) and
are not meant for an app. Listed only for completeness.

## Not found

- No Job, Batch or production-order controller. "Batch" is only an identifier type.
- No order queue, sequence or planned start and end times.
- No pause or resume of an order.
- No client timestamp on `SetOrderToMachine`, `UpdateStateMachineManual` or `AddUnitManual`.
- No typed response schemas.

## New swagger vs old (order related)

43 new paths, 2 removed; none of either is about orders (new: CustomReportSchedule,
CustomReportStored, SelfSignup, TableStats, PlatformSettings MCP context). Ignoring "Success" to
"OK" in response descriptions, the order-related changes are:

| What | Change |
|---|---|
| `GET /api/PartOrderNumber/GetByPage` | New query param `Status` (`PartOrderNumberStatusFilter`, new schema, 0 to 2) |
| `ProcessEventDTO` | New field `messageSource` (`WasteEventMessageSource`, which gained value 6) |
| `GET /api/Machine/GetByPage` | New `FactoryIds`, `FilterAccountIds` |

`SetOrderToMachine`, `SetMachinePartInformation`, `PartOrderNumberDTO` and every other order call
are unchanged.

## Open questions for the backend owner

1. `SetMachinePartInformation`: does `timeOfOccurence` in the past back-date the start (and end the
   previous run at that time)? Does an empty name stop the order? Does it create a missing order?
2. `SetOrderToMachine` with a new number: does it always create the `PartOrderNumber`, or only when
   the factory has `isEnableOperatorPanelCreatePartInformation`?
3. Is there a way to stop an order at a given time, for a stop sent late from the outbox?
4. Does a late or out-of-order call (start of A arriving after start of B) corrupt the runs?
5. What should `data` look like from `GetCurrentOrderActiveByMachineId` (fields besides `number`, `startDate`)?
6. Will OEE on a machine with no IoT signal make sense, or should the stations only use order time?
7. Is `dataexport.optipeople.dk` with the account's `Opti` code the intended way for an integration,
   or bearer login on `api.optipeople.dk`?

## Live test 2026-11-10

Run against production `https://api.optipeople.dk` as `ventisolserviceaccount@optipeople.dk`, on
machine "Station 10" (`201f8152-cbd1-4a3b-c9ac-08df3f1a322f`, factory "Ventisol - Vrå"
`7d8f4bec-dfce-4a89-efc2-08d85ecac2d3`). The only writes were `SetOrderToMachine` on that machine
with `58556`, `58557`, `""`, `null` and no `number`. Times below are server time (Danish, UTC+1).

### Summary

- `SetOrderToMachine` answers HTTP 200 with the new run in `data`. Every call starts a **new run**
  (new `partInformationId`, new `startDate`), even with the number already current. It is not
  idempotent.
- A number that does not exist is **created** in the machine's factory on the spot, as
  `identifierType: 0` ("Batch Number"), `status: 0`. No factory setting got in the way.
- Switching to another number ends the current run and starts the new one in the same call.
- `number: ""`, `number: null` and no `number` at all do the same thing: they switch the machine to
  a hidden **default order** (`isDefaultPartInfo: true`, `number: ""`), a `PartOrderNumber` the server
  creates once per factory or machine. The machine never goes back to the "no order at all" state it
  was in before the first call (zero GUIDs, `number: null`). Treat `number == ""` or
  `isDefaultPartInfo == true` as "no order".
- `""` twice: both 200, the second also opens a new default run. No error.
- No call gave an error. Each `SetOrderToMachine` took 160 to 430 ms (one outlier of 1.3 s); reads
  took 90 to 250 ms.
- Run end dates could not be read back: `GetPartOrderTimeRangesByDates`, `...ByWeeks`,
  `Report/ExternalExportUnitInformation(V2)` returned empty lists and `DataExport/GetOrderReportExport`
  answered 400, `Report/CurrentUnitInformation` 500. The machine has no active shift
  (`GetCurrentMachineState` gives `machineRunningState: 0`), which is the likely reason. So that a
  switch sets `endDate` on the old run is inferred from it no longer being current, not seen.

### 1. Before

`GET /api/RealtimeDashboard/GetCurrentOrderActiveByMachineId?machineId=<Station 10>` (200, 204 ms):

```json
{"data":{"partInformationId":"00000000-0000-0000-0000-000000000000","partOrderNumberId":"00000000-0000-0000-0000-000000000000",
 "number":null,"isDefaultPartInfo":false,"startDate":"0001-01-01T00:00:00+00:00","endDate":null,
 "expectedSpeed":0,"totalAmountToProduce":null,"partOrderType":0,"partCounters":null},"errors":[],"meta":{}}
```

The factory had no orders at all (`PartOrderNumber/GetByPage?FactoryId=...` count 0);
`GetOrderNumber?machineId=&number=58556` and `58557` gave `"data":[]`.

### 2. Start 58556

```json
POST /api/RealtimeDashboard/SetOrderToMachine
{"machineId":"201f8152-cbd1-4a3b-c9ac-08df3f1a322f","number":"58556","expectedSpeed":0}
```

200, 356 ms:

```json
{"data":{"partInformationId":"3182f5a2-79fe-4cbd-a53f-08df3bb22153","partOrderNumberId":"10993302-c47b-4004-eafd-08df3bb497e8",
 "number":"58556","startDate":"2026-11-10T12:33:41.0030537","endDate":null,"expectedSpeed":0,"totalAmountToProduce":null,
 "produced":0.0,"rejected":0.0,"totalUptimeInSeconds":0,"totalPartInformationTimeInSeconds":0,"partOrderType":0,"partCounters":[]},
 "errors":[],"meta":{}}
```

Note `startDate` has no offset in this response; `GetCurrentOrderActiveByMachineId` gives the same
time with `+01:00`. Afterwards `GetCurrentOrderActiveByMachineId` shows the same ids, `number: "58556"`,
`isDefaultPartInfo: false`, `partOrderType: 0`. The order now exists, found by `GetOrderNumber`,
`PartOrderNumber/GetByMachineIdAndNumber` and `GetByPage?FactoryId=` (count 1):

```json
{"id":"10993302-c47b-4004-eafd-08df3bb497e8","number":"58556","factoryId":"7d8f4bec-dfce-4a89-efc2-08d85ecac2d3",
 "identifierType":0,"typeName":"Batch Number","status":0,"isDefaultPartInfo":false,"isCanDelete":false,
 "machineId":null,"expectedSpeed":null,"totalAmountToProduce":null,"updateDate":"2026-11-10T12:33:41.0055328", ...}
```

`isCanDelete` is false while the order is current on a machine, and turned true once it was not.
`Machine/GetByPage` kept `currentOPNumber: null` throughout; it does not reflect this.
`GetByPage` ignored `keyword` (echoed `"keyword":""`) in every spelling tried.

### 3. 58556 again

Same body, 200, 278 ms. New run, same order:

```json
{"data":{"partInformationId":"486fadbe-ef23-4329-bf5d-08df3bb49452","partOrderNumberId":"10993302-c47b-4004-eafd-08df3bb497e8",
 "number":"58556","startDate":"2026-11-10T12:33:49.3190409", ...}}
```

`GetCurrentOrderActiveByMachineId` shows the new `partInformationId` and new `startDate`. No second
`PartOrderNumber` was made (count stays 1). So a repeated scan of the order already running would cut
its run in two; the station should not resend a start for the order that is already current.

### 4. Switch to 58557

`{"machineId":"...","number":"58557","expectedSpeed":0}`, 200, 302 ms:

```json
{"data":{"partInformationId":"9baa69c0-eb81-4242-bf5e-08df3bb49452","partOrderNumberId":"5c139d05-9ac4-4f4f-1e4d-08df3bb4944f",
 "number":"58557","startDate":"2026-11-10T12:34:17.2156199","endDate":null, ...}}
```

58557 is created (Batch Number) and current; 58556 is no longer current and its `isCanDelete`
became true. Both are now in `GetOrderNumberByMachineId` (the widget's pick list).

### 5. Clear with `""`

`{"machineId":"...","number":"","expectedSpeed":0}`, 200, 430 ms:

```json
{"data":{"partInformationId":"d442fca1-1799-4f01-bf5f-08df3bb49452","partOrderNumberId":"cd8ebad5-2bf6-42ea-1e4e-08df3bb4944f",
 "number":"","startDate":"2026-11-10T12:34:35.1256425","endDate":null, ...}}
```

`GetCurrentOrderActiveByMachineId` then shows `number: ""`, `isDefaultPartInfo: true` with that
`partOrderNumberId`. The default order (`PartOrderNumber/GetById`):

```json
{"id":"cd8ebad5-2bf6-42ea-1e4e-08df3bb4944f","number":"","isDefaultPartInfo":true,"identifierType":0,"status":0,
 "factoryId":"7d8f4bec-dfce-4a89-efc2-08d85ecac2d3", ...}
```

It is left out of `GetByPage` (count stays 2) and `GetOrderNumberByMachineId`.

### 6. `null` and no `number`

From 58557 running, `{"machineId":"...","number":null,"expectedSpeed":0}` and `{"machineId":"..."}`
each gave 200 and switched to the same default order `cd8ebad5-...`, `number: ""`, exactly like `""`.

### 7. `""` twice

Second `""` right after the first: 200, 172 ms, a new `partInformationId` (`b74689d5-...`) on the
same default order. `GetCurrentOrderActiveByMachineId` then showed the new `partInformationId` but
kept the `startDate` of the first default run (12:34:35.1256425), so back-to-back default runs seem
to be shown as one. No error came back from anything tried.

### 8. End state

Last call `""`. Station 10 shows `number: ""`, `isDefaultPartInfo: true` (no real order).
Left behind in the factory: orders 58556 and 58557 (Batch Number, status Active) and the default
order; the test made 10 short runs (10 `SetOrderToMachine` calls) on Station 10 between 12:33:41 and 12:35:04 on 2026-11-10.

## Order custom fields

Tested live on 2026-11-10 against production, on Station 10 only (`201f8152-cbd1-4a3b-c9ac-08df3f1a322f`,
factory `7d8f4bec-dfce-4a89-efc2-08d85ecac2d3`), with the element barcodes `058556050103` and
`058557050101` as order numbers. Station 10 was left on `number: ""` (default order).

### Two different kinds

OptiCloud has two unrelated custom field systems for orders:

| | Per-order fields (`customFieldItems`) | Per-machine fields (`machineOrderCustomFields`) |
|---|---|---|
| Where defined | Nowhere. Free label and value pairs stored **on each `PartOrderNumber`** (factory level) | Labels defined **per machine** (`MachineOrderCustomField`), max 5 in the backoffice UI |
| Enabled by | Nothing | `hasOrderCustomFieldsEnabled` on the machine |
| Write | `PartOrderNumber/ExternalSetPartOrder` or `PartOrderNumber/Update` | `PUT /api/Machine/UpdateMachineOrderCustomFieldValues` |
| Read back | `GetOrderNumber`, `PartOrderNumber/GetById`, `GetByMachineIdAndNumber`, `GetByPage` | **Not found.** Every read returns `machineOrderCustomFieldValues: []` |
| Shown in | The dashboard "Order" widget (`orderDetails.customFieldItems`, by `customFieldType`) | No backoffice screen, except the machine settings page that defines the labels |

**Use `customFieldItems`.** They need no setup, they come back from the same lookup the station
already does, and the widget shows them. The per-machine fields could be defined and a value write
returned 200, but nothing reads the values back over the API (probably only the operator panel app
does), so they are documented below for completeness only.

### `SetOrderToMachine` ignores custom fields

Sent with all three arrays on top of `{machineId, number, expectedSpeed, totalAmountToProduce}`:

```json
{"machineId":"201f8152-...","number":"058557050101","expectedSpeed":0,"totalAmountToProduce":null,
 "customFieldItems":[{"customFieldType":0,"label":"Ordre","value1":"58557","sortOrder":0}, ...],
 "machineOrderCustomFields":[{"id":"fad48b68-...","label":"Ordre","value":"58557"}],
 "machineOrderCustomFieldValues":[{"machineOrderCustomFieldId":"fad48b68-...","label":"Ordre","value":"58556"}, ...]}
```

200, the run started as usual, and the order came back with `customFieldItems: []` and
`machineOrderCustomFieldValues: []`. So a second call is needed. The backoffice widget never sends
custom fields either: its `setOrderToMachine` posts only `machineId`, `number`,
`totalAmountToProduce`, `expectedSpeed`.

### Setting the fields: `POST /api/PartOrderNumber/ExternalSetPartOrder` (recommended)

```json
{"factoryId":"7d8f4bec-dfce-4a89-efc2-08d85ecac2d3","partOrderNumber":"058557050101",
 "customFields":[{"label":"Ordre","text":"58557"},{"label":"Position","text":"5"},
                 {"label":"Underposition","text":"1"},{"label":"Emne","text":"1"}]}
```

200, `{"data":null,"errors":[],"meta":{}}`, 240 to 540 ms. Then `GetOrderNumber?machineId=&number=058557050101`:

```json
{"data":[{"id":"b08d7631-d844-47f9-1e50-08df3bb4944f","number":"058557050101","factoryId":"7d8f4bec-...",
 "identifierType":0,"status":0,"isDefaultPartInfo":false,
 "customFieldItems":[
  {"id":"958d6537-...","customFieldType":0,"label":"Ordre","value1":"58557","value2":null,"sortOrder":0,"imageRefId":null},
  {"id":"b9435dc2-...","customFieldType":0,"label":"Position","value1":"5","value2":null,"sortOrder":0,"imageRefId":null},
  {"id":"ad3497f0-...","customFieldType":0,"label":"Underposition","value1":"1","value2":null,"sortOrder":0,"imageRefId":null},
  {"id":"cf47143a-...","customFieldType":0,"label":"Emne","value1":"1","value2":null,"sortOrder":0,"imageRefId":null}],
 "machineOrderCustomFields":[],"machineOrderCustomFieldValues":[]}],"errors":[],"meta":{}}
```

- Fields become `customFieldType: 0` (text) with `value1` = `text`. Every `sortOrder` is 0; the list
  came back in the order sent.
- **Idempotent.** Sent a second time with the same body: still four items, same ids. It upserts by
  label.
- It does **not** touch the run: the machine's current `partInformationId` and `startDate` were
  unchanged after it. So it can be sent after `SetOrderToMachine` without cutting the run.
- Needs only `factoryId`, no machine.
- Not tested: whether it creates an order that does not exist yet (both test numbers already
  existed). The swagger calls it "create or update". Sending it after `SetOrderToMachine`, which
  is known to create the order, avoids depending on that.
- Values are free strings, stored as sent. Send `"58556"`, `"5"`, `"1"`, `"3"` (or padded, as the UI
  should show them).

### Alternative: `PUT /api/PartOrderNumber/Update`

What the backoffice order editor sends. Needs the order id, so a lookup first:

```json
{"id":"8a216ab8-5775-4a23-1e4f-08df3bb4944f","number":"058556050103","factoryId":"7d8f4bec-dfce-4a89-efc2-08d85ecac2d3",
 "identifierType":0,"status":0,
 "customFieldItems":[
  {"id":null,"customFieldType":0,"label":"Ordre","value1":"58556","value2":"","sortOrder":0},
  {"id":null,"customFieldType":0,"label":"Position","value1":"5","value2":"","sortOrder":1},
  {"id":null,"customFieldType":0,"label":"Underposition","value1":"1","value2":"","sortOrder":2},
  {"id":null,"customFieldType":0,"label":"Emne","value1":"3","value2":"","sortOrder":3}]}
```

200, `data: null`. Read back in the same shape as above, with `sortOrder` 0 to 3 kept. It is a
full replace of the order, so it also writes `identifierType`, `status` and the rest, and fields
left out may be reset. Prefer `ExternalSetPartOrder`.

### Reading them back

- `GET /api/RealtimeDashboard/GetOrderNumber?machineId=&number=` gives `data[0].customFieldItems`
  (so do `PartOrderNumber/GetById?partOrderId=`, `PartOrderNumber/GetByMachineIdAndNumber`,
  `GetByMachineId` and `GetByPage`).
- `GET /api/RealtimeDashboard/GetCurrentOrderActiveByMachineId` has **no** custom fields, only
  `partOrderNumberId` and `number`. Read the fields with `GetOrderNumber` on that number.
- `Report/CurrentUnitInformation` (which has `customFields` per the External API doc) answered 500
  on Station 10, and so did `OperatorPanelApp/GetByMachineIdAndNumber`.

### Per-machine fields, as found

`GET /api/MachineOrderCustomField/GetByMachineId/{machineId}`. On "Montage Kvalitet":

```json
{"data":{"machineId":"75c5ac14-ef3a-422b-f68e-08ddda1d0267","hasOrderCustomFieldsEnabled":true,
 "machineOrderCustomFields":[{"id":"749d8393-471c-47ae-e1c6-08dea9b8a0d6","label":"Order No","value":"Order No"}]},
 "errors":[],"meta":{}}
```

On a machine without them: `hasOrderCustomFieldsEnabled: false`, `machineOrderCustomFields: []`.
`value` is the label again (the backoffice sends `value: label`).

Defined on Station 10 with `POST /api/MachineOrderCustomField/Create`:

```json
{"machineId":"201f8152-cbd1-4a3b-c9ac-08df3f1a322f","hasOrderCustomFieldsEnabled":true,
 "machineOrderCustomFields":[{"label":"Ordre","value":"Ordre"},{"label":"Position","value":"Position"},
  {"label":"Underposition","value":"Underposition"},{"label":"Emne","value":"Emne"}]}
```

200, the response has the same shape as `GetByMachineId`, with ids (`fad48b68-...` Ordre,
`ac96d82d-...` Position, `d9d5283d-...` Underposition, `758ffcc6-...` Emne), in the order sent.
`PUT /api/MachineOrderCustomField/Update` with the same body plus each `id` returned the same four,
unchanged. The backoffice uses `Create` when no field has an id yet and `Update` otherwise;
`ToggleFeature/{machineId}?enabled=` flips only the flag. A second `Create` was not tried (it would
likely add duplicates, and nothing could be deleted).

Values written with `PUT /api/Machine/UpdateMachineOrderCustomFieldValues`:

```json
{"machineId":"201f8152-...","machineOrderCustomFieldValues":[
 {"machineOrderCustomFieldId":"fad48b68-...","partOrderNumberId":"8a216ab8-...","partOrderNumberName":"058556050103",
  "label":"Ordre","value":"58556"}, ...]}
```

200, `data: null`, but no read shows them (`GetOrderNumber`, `GetById`, `GetByMachineIdAndNumber`,
`GetByPage`, `GetPartOrderNumberFactoryByMachineId` all give `machineOrderCustomFieldValues: []`;
`MachineOrderCustomField/Get/{id}` gives only `{id, label, value}`).

### What the station app should do

No first-connect setup is needed for `customFieldItems`. Per scanned element:

1. `POST /api/RealtimeDashboard/SetOrderToMachine`
   `{machineId, number: "058556050103", expectedSpeed: 0, totalAmountToProduce: null}`
   (skip when that number is already current, see the live test above).
2. `POST /api/PartOrderNumber/ExternalSetPartOrder`
   `{factoryId, partOrderNumber: "058556050103", customFields: [{label: "Ordre", text: "58556"}, {label: "Position", text: "5"}, {label: "Underposition", text: "1"}, {label: "Emne", text: "3"}]}`.
   Safe to resend; could be skipped when `GetOrderNumber` already shows the four labels.

The one thing to get on first connect is the machine's `factoryId` (or keep it in settings).

If the per-machine fields are wanted anyway (for the operator panel), the idempotent setup per
machine is: `GET MachineOrderCustomField/GetByMachineId/{machineId}`. If the four labels are there
and `hasOrderCustomFieldsEnabled` is true, do nothing. If the list is empty, `POST Create` with the
four labels and `hasOrderCustomFieldsEnabled: true`. Otherwise `PUT Update` with the existing items
(with their ids, so other fields the machine has are kept) plus the missing labels (no id), and
`hasOrderCustomFieldsEnabled: true`. Keep the total at 5 or fewer.

### Left behind by this test

Orders `058556050103` and `058557050101` in the factory, each with four `customFieldItems`; the four
per-machine field definitions and `hasOrderCustomFieldsEnabled: true` on Station 10; one write of
per-machine values for `058556050103`; 3 short runs on Station 10 (13:19:33 to 13:21:19).
