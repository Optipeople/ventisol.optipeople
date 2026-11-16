// The sections of Indstillinger and what each needs. Pure, safe to import
// from client components. This decides what is shown; every page still
// guards itself, and row level security guards the data.

import { can, type Capability, type PortalRole } from "@/lib/portal/roles";

export type SettingsSection = {
  id: string;
  label: string;
  href: string;
  /** The capability needed to open the section. */
  needs: Capability;
  /** One line for the overview and the page header. */
  intro: string;
};

export const SETTINGS_PATH = "/indstillinger";

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: "brugere",
    label: "Brugere",
    href: "/indstillinger/brugere",
    needs: "users.manage",
    intro: "Hvem der har adgang til portalen, og med hvilken rolle.",
  },
  {
    id: "stationer",
    label: "Stationer",
    href: "/indstillinger/stationer",
    needs: "settings.view",
    intro: "Stationernes navn, art, maskine i OptiCloud og rækkefølge.",
  },
  {
    id: "elementtyper",
    label: "Elementtyper",
    href: "/indstillinger/elementtyper",
    needs: "settings.view",
    intro: "Typerne af elementer, og hvordan de genkendes i produktionslisten fra 3E.",
  },
  {
    id: "tider",
    label: "Tider",
    href: "/indstillinger/tider",
    needs: "times.edit",
    intro: "Normaltid og kalkuleret tid pr. station og elementtype.",
  },
  {
    id: "kalender",
    label: "Kalender",
    href: "/indstillinger/kalender",
    needs: "times.edit",
    intro: "Skift pr. ugedag og lukkedage.",
  },
  {
    id: "graensevaerdier",
    label: "Grænseværdier",
    href: "/indstillinger/graensevaerdier",
    needs: "times.edit",
    intro: "Hvornår noget tæller som forsinket, langsomt eller stillestående.",
  },
  {
    id: "synkronisering",
    label: "Synkronisering",
    href: "/indstillinger/synkronisering",
    needs: "sync.view",
    intro: "Status for hentning af scanninger og dokumenter fra OptiCloud.",
  },
  {
    id: "log",
    label: "Hændelseslog",
    href: "/indstillinger/log",
    needs: "audit.view",
    intro: "Hvem der har ændret hvad, og hvornår.",
  },
];

/** The sections `role` may open, in order. */
export function settingsSectionsFor(role: PortalRole): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => can(role, section.needs));
}

export function settingsSection(id: string): SettingsSection {
  const section = SETTINGS_SECTIONS.find((s) => s.id === id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}
