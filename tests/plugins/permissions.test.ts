import { describe, expect, it } from "bun:test";

import { InMemoryPermissionAuditLog } from "../../src/plugins/audit";
import {
  PERMISSION_DESCRIPTIONS,
  PluginPermissionChecker,
  PluginPermissionError,
} from "../../src/plugins/permissions";
import type { PluginPermission } from "../../src/types";

const ALL_PERMISSIONS = Object.keys(PERMISSION_DESCRIPTIONS) as PluginPermission[];

describe("PluginPermissionChecker", () => {
  it("grants allowed permissions", () => {
    const audit = new InMemoryPermissionAuditLog();
    const checker = new PluginPermissionChecker("weather", ["read_notes"], audit);

    expect(checker.hasPermission("read_notes")).toBe(true);
  });

  it("denies disallowed permissions", () => {
    const audit = new InMemoryPermissionAuditLog();
    const checker = new PluginPermissionChecker("weather", ["read_notes"], audit);

    expect(checker.hasPermission("write_notes")).toBe(false);
  });

  it("requirePermission throws PluginPermissionError for denied permission", () => {
    const audit = new InMemoryPermissionAuditLog();
    const checker = new PluginPermissionChecker("weather", ["read_notes"], audit);

    expect(() => checker.requirePermission("write_notes")).toThrow(PluginPermissionError);
  });

  it("records granted and denied attempts in audit log", () => {
    const audit = new InMemoryPermissionAuditLog();
    const checker = new PluginPermissionChecker("weather", ["read_notes"], audit);

    checker.hasPermission("read_notes");
    checker.hasPermission("write_notes");
    try {
      checker.requirePermission("write_notes");
    } catch {
      // expected
    }

    const entries = audit.getEntries("weather");
    expect(entries).toHaveLength(3);
    expect(entries.filter((entry) => entry.granted)).toHaveLength(1);
    expect(entries.filter((entry) => !entry.granted)).toHaveLength(2);
  });

  it("denies all permissions when plugin requests none", () => {
    const checker = new PluginPermissionChecker("weather", [], new InMemoryPermissionAuditLog());

    expect(checker.getGrantedPermissions()).toEqual([]);
    expect(checker.getDeniedPermissions().length).toBeGreaterThan(0);
    expect(checker.hasPermission("read_calendar")).toBe(false);
  });

  it("returns no denied permissions when all are granted", () => {
    const checker = new PluginPermissionChecker(
      "weather",
      ALL_PERMISSIONS,
      new InMemoryPermissionAuditLog(),
    );

    expect(checker.getDeniedPermissions()).toEqual([]);
    expect(checker.getGrantedPermissions()).toEqual(ALL_PERMISSIONS);
  });

  it("filters audit log by plugin name", () => {
    const audit = new InMemoryPermissionAuditLog();
    const weather = new PluginPermissionChecker("weather", ["read_notes"], audit);
    const calendar = new PluginPermissionChecker("calendar", ["read_calendar"], audit);

    weather.hasPermission("read_notes");
    calendar.hasPermission("read_calendar");

    const weatherEntries = audit.getEntries("weather");
    expect(weatherEntries).toHaveLength(1);
    expect(weatherEntries[0]?.pluginName).toBe("weather");
  });
});
