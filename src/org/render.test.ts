import { describe, expect, it } from "vitest";
import { renderOrgTable, renderNoOrg } from "./render.js";

const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("renderOrgTable", () => {
  it("renders a header and one aligned row with an active marker", () => {
    const out = plain(
      renderOrgTable([{ slug: "acme-corp", role: "owner", memberCount: 12, active: true }]),
    );
    const [header, row] = out.split("\n") as [string, string];
    expect(header).toContain("SLUG");
    expect(header).toContain("ROLE");
    expect(header).toContain("MEMBERS");
    expect(header).toContain("ACTIVE");
    expect(row).toContain("acme-corp");
    expect(row).toContain("owner");
    expect(row).toContain("12");
    expect(row.trimEnd().endsWith("●")).toBe(true);
  });

  it("shows an em-dash when member count is unknown and no dot when inactive", () => {
    const out = plain(renderOrgTable([{ slug: "side", role: "owner", active: false }]));
    const row = out.split("\n")[1]!;
    expect(row).toContain("—");
    expect(row).not.toContain("●");
  });
});

describe("renderNoOrg", () => {
  it("names both remedies", () => {
    const out = plain(renderNoOrg("dave@acme.co"));
    expect(out).toContain("poppi org create");
    expect(out).toContain("poppi org join <code>");
    expect(out).toContain("dave@acme.co");
  });
});
