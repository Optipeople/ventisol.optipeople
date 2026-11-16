import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLE,
  can,
  CAPABILITY_LIST,
  DEFAULT_ROLE,
  hasAnyRole,
  isPortalRole,
  PORTAL_ROLES,
  ROLE_LABELS,
  roleLabel,
  rolesWith,
  type Capability,
  type PortalRole,
} from "@/lib/portal/roles";

// The whole matrix, written out, so a change to roles.ts has to be made twice
// on purpose. Columns: admin, ledelse, planner, viewer.
const MATRIX: Record<Capability, [boolean, boolean, boolean, boolean]> = {
  "reports.view": [true, true, true, true],
  "ledelse.view": [true, true, false, false],
  "costs.view": [true, true, true, false],
  "chat.use": [true, true, true, true],
  "settings.view": [true, false, true, false],
  "times.edit": [true, false, true, false],
  "masterdata.edit": [true, false, false, false],
  "users.manage": [true, false, false, false],
  "audit.view": [true, false, false, false],
  "sync.view": [true, false, false, false],
};

const COLUMNS: PortalRole[] = ["admin", "ledelse", "planner", "viewer"];

describe("roles", () => {
  it("lists the four roles, most powerful first", () => {
    expect(PORTAL_ROLES).toEqual(COLUMNS);
    expect(ADMIN_ROLE).toBe("admin");
    expect(DEFAULT_ROLE).toBe("viewer");
  });

  it("has a Danish label for every role", () => {
    expect(ROLE_LABELS).toEqual({
      admin: "Administrator",
      ledelse: "Ledelse",
      planner: "Planlægger",
      viewer: "Læser",
    });
    expect(roleLabel("planner")).toBe("Planlægger");
  });

  it("recognises a role and nothing else", () => {
    for (const role of COLUMNS) expect(isPortalRole(role)).toBe(true);
    for (const other of ["Admin", "", "superadmin", null, undefined, 1]) {
      expect(isPortalRole(other)).toBe(false);
    }
  });

  it("hasAnyRole", () => {
    expect(hasAnyRole("ledelse", ["admin", "ledelse"])).toBe(true);
    expect(hasAnyRole("planner", ["admin", "ledelse"])).toBe(false);
    expect(hasAnyRole("admin", [])).toBe(false);
  });
});

describe("can", () => {
  it("covers every capability in the matrix", () => {
    expect([...CAPABILITY_LIST].sort()).toEqual(Object.keys(MATRIX).sort());
  });

  for (const [capability, row] of Object.entries(MATRIX) as [Capability, boolean[]][]) {
    it(`${capability}`, () => {
      expect(COLUMNS.map((role) => can(role, capability))).toEqual(row);
      expect(rolesWith(capability)).toEqual(COLUMNS.filter((_, i) => row[i]));
    });
  }

  it("admin can do everything", () => {
    for (const capability of CAPABILITY_LIST) expect(can("admin", capability)).toBe(true);
  });

  it("a viewer never sees cost figures", () => {
    expect(can("viewer", "costs.view")).toBe(false);
  });
});
