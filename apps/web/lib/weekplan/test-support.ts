// Shared by the week plan tests: order 58781 as the 3E database holds it.

import type { WeekPlanTables } from "./mdb";

/** Order 58781 as 3E holds it: three top hung Danline windows and a terrace door. */
export function tables(): WeekPlanTables {
  const id = "K1";
  const pos = (Position: number, Stueck: number, extra: Record<string, unknown>) => ({
    ID_A_Kopf: id,
    Position,
    Stueck,
    SerieNr: 0,
    PosZeit: 0,
    AnzFlg: 0,
    FSystem: "70 mm DANLINE",
    Typnummer: null,
    P_Art: 0,
    ...extra,
  });
  return {
    A_Kopf: [
      { ID: id, AuNummer: 58781, A_Summe: 21528, Sachbearb1: "Flemming B" },
      { ID: "K2", AuNummer: 58790, A_Summe: 6663, Sachbearb1: "Flemming B" },
    ],
    A_KopfFreie: [
      { ID_A_Kopf: id, Feld1: "2", Feld2: "ja", Feld3: "ja", Feld4: null, Feld6: "Kogreb knop begge sider", Feld9: "(kein)" },
      { ID_A_Kopf: "K2", Feld4: "Bestilt", Feld36: "sidste felt" },
    ],
    A_Adresse: [
      { ID_A_Kopf: id, Nummer: 0, Firma: "Kongerslev Trælast Aps" },
      { ID_A_Kopf: id, Nummer: 1, Firma: "Leveringsadresse" },
    ],
    A_Planung: [
      { ID_A_Kopf: id, WocheW: "2648" },
      { ID_A_Kopf: "K2", WocheW: "2649" },
    ],
    A_Vorgang: [
      { ID_A_Kopf: id, Nummer: "_AufAnlage", Benutzer: "FBV" },
      { ID_A_Kopf: id, Nummer: "_AufDruck", Benutzer: "mub" },
      { ID_A_Kopf: "K2", Nummer: "_AngAnlage", Benutzer: "FBV" },
    ],
    P_Allgemein: [
      { ID_A_Kopf: id, Position: 0, Positionstext: "TD \r\nTD HU 105T alu" },
      { ID_A_Kopf: id, Position: 1, Positionstext: "TS\r\nTopstyret" },
      { ID_A_Kopf: id, Position: 2, Positionstext: "TD \r\nTD HU 105T alu" },
      { ID_A_Kopf: id, Position: 3, Positionstext: "Fragt / forsendelse\r\n" },
    ],
    P_Technik: [
      pos(0, 1, { PosZeit: 999 }),
      pos(1, 4, { SerieNr: 260825, PosZeit: 85.4, AnzFlg: 1 }),
      pos(2, 1, { SerieNr: 260827, PosZeit: 132.86, AnzFlg: 1, FSystem: "70 mm softline" }),
      pos(3, 1, { P_Art: 3, Typnummer: "Fragt:" }),
    ],
    P_Element: [
      { ID_A_Kopf: id, Position: 1, Ez: 1, Feldnummer: "00~00" },
      { ID_A_Kopf: id, Position: 2, Ez: 1, Feldnummer: "00~00" },
    ],
    // Four foiled windows and a white door: partly foiled.
    P_Werkstoffe: [
      { ID_A_Kopf: id, Position: 0, Farbe1: "Hvid", Farbe2: "(kein)" },
      { ID_A_Kopf: id, Position: 1, Farbe1: "FAnthrazitgrå/h", Farbe2: "(kein)" },
      { ID_A_Kopf: id, Position: 2, Farbe1: "Hvid", Farbe2: "(kein)" },
    ],
    // Order 58790 buys from HTM.
    P_Artikel: [
      { ID_A_Kopf: id, Kreditor: "Veka" },
      { ID_A_Kopf: "K2", Kreditor: "HTM" },
    ],
  };
}
