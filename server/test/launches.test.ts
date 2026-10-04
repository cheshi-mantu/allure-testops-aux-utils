import { describe, expect, it } from "vitest";
import { envValues, envVars, launchQuery, launchTags, listLaunches } from "../src/launches.js";
import { useMock } from "./mock.js";

const client = useMock();

describe("launchQuery", () => {
  it("joins the AQL with the search text", () => {
    expect(launchQuery("", "")).toBe("");
    expect(launchQuery('tag = "a" or tag = "b"', "")).toBe('(tag = "a" or tag = "b")');
    expect(launchQuery("", 'nightly "x"')).toBe('name ~= "nightly \\"x\\""');
    expect(launchQuery('tag = "a"', "42")).toBe('(tag = "a") and (id = 42 or name ~= "42")');
  });
});

describe("listLaunches", () => {
  it("lists the latest launches with environment and counts", async () => {
    const list = await listLaunches(client(), 1, "", "");
    expect(list.total).toBe(12);
    expect(list.launches[0]).toMatchObject({ name: "Web Shop nightly #100", tags: ["nightly", "ui", "release-candidate"] });
    expect(list.launches[0].env).toContainEqual({ name: "browser", value: "firefox" });
    expect(list.launches[0].statistic?.length).toBeGreaterThan(0);
  });

  it("filters by tags and single environment variables with AND / OR", async () => {
    const byTag = await listLaunches(client(), 1, 'tag = "nightly"', "");
    expect(byTag.launches.map((l) => l.name)).toEqual(["Web Shop nightly #100", "Web Shop nightly #96", "Web Shop nightly #92"]);

    const either = await listLaunches(client(), 1, 'ev["browser"] = "safari" and ev["stand"] = "prod" or tag = "release-candidate"', "");
    for (const l of either.launches) {
      const env = (n: string) => l.env.filter((e) => e.name === n).map((e) => e.value);
      expect((env("browser").includes("safari") && env("stand").includes("prod")) || l.tags.includes("release-candidate")).toBe(true);
    }
    expect(either.total).toBe(either.launches.length);
    expect(either.launches[0].statistic).not.toBeNull();

    const noOs = await listLaunches(client(), 1, 'ev["os"] = null', "");
    expect(noOs.launches.every((l) => !l.env.some((e) => e.name === "os"))).toBe(true);
    expect(noOs.total).toBeGreaterThan(0);
  });

  it("combines the filter with the name search and rejects invalid AQL", async () => {
    const list = await listLaunches(client(), 1, 'not (tag in ["smoke", "regress"])', "release");
    expect(list.launches.map((l) => l.name)).toEqual(["Web Shop release #98", "Web Shop release #94", "Web Shop release #90"]);
    await expect(listLaunches(client(), 1, "tag = ", "")).rejects.toThrow(/Invalid AQL/);
  });
});

describe("suggestions", () => {
  it("suggests tags, variables and values", async () => {
    expect((await launchTags(client(), 1, "rel")).map((t) => t.name)).toEqual(["release", "release-candidate"]);
    const vars = await envVars(client(), "");
    expect(vars.map((v) => v.name)).toEqual(["browser", "os", "stand"]);
    const browser = vars.find((v) => v.name === "browser")!;
    expect((await envValues(client(), 1, browser.id, "f")).map((v) => v.name)).toEqual(["firefox", "safari"]);
  });
});
