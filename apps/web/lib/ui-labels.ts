import type { UiLabels } from "@optipeople/ui";

/** Danish text for everything @optipeople/ui renders by itself. */
export const UI_LOCALE = "da-DK";

export const UI_LABELS: Partial<UiLabels> = {
  cancel: "Annuller",
  close: "Luk",
  delete: "Slet",
  ok: "OK",
  remove: "Fjern",
  search: "Søg",
  clearSearch: "Ryd søgning",
  closeDialog: "Luk dialog",
  loading: "Indlæser",
  moreInformation: "Mere information",
  clear: "Ryd",
  writeHere: "Skriv her.",

  pagination: "Sider",
  previousPage: "Forrige side",
  nextPage: "Næste side",
  pageNumber: "Side {page}",

  searchInMenu: "Søg…",
  searchOptions: "Søg i valgmuligheder",
  noMatches: "Ingen match",
  clearSelection: "Ryd valg",
  selectedCount: "{count} valgt",

  dateFormat: "dd-mm-åååå",
  dateFormatHint: "Indtast en dato som {format}.",
  dateInvalid: "Ikke en gyldig dato. Brug {format}.",
  openCalendar: "Åbn kalender",
  previousMonth: "Forrige måned",
  nextMonth: "Næste måned",
  weekNumberColumn: "Ugenummer",
  weekAbbr: "Uge",
  today: "I dag",
};
