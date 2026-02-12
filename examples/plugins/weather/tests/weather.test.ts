import { describe, expect, it } from "bun:test";

import { MockPluginContext } from "@reins/sdk";

import plugin from "../src/index";
import { getMockForecast, getMockWeather } from "../src/weather-data";
import { weatherTool } from "../src/weather-tool";

const TOOL_CONTEXT = {
  conversationId: "conversation-1",
  userId: "user-1",
};

describe("weather plugin", () => {
  it("activates and registers weather tool", () => {
    const context = new MockPluginContext();

    plugin.activate(context);

    expect(context.getRegisteredTool("weather")).toBeDefined();
  });

  it("handles get_weather action", async () => {
    const result = await weatherTool.execute(
      {
        action: "get_weather",
        location: "Seattle",
      },
      TOOL_CONTEXT,
    );

    expect(result.error).toBeUndefined();
    expect(result.name).toBe("weather");
    expect(result.result).toEqual({
      action: "get_weather",
      data: expect.objectContaining({
        location: "Seattle",
        units: "metric",
      }),
    });
  });

  it("handles get_forecast action", async () => {
    const result = await weatherTool.execute(
      {
        action: "get_forecast",
        location: "Berlin",
        units: "imperial",
        days: 3,
      },
      TOOL_CONTEXT,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      action: "get_forecast",
      data: expect.objectContaining({
        location: "Berlin",
        units: "imperial",
        days: expect.any(Array),
      }),
    });

    const payload = result.result as { action: string; data: { days: unknown[] } };
    expect(payload.data.days).toHaveLength(3);
  });

  it("returns error for unknown action", async () => {
    const result = await weatherTool.execute(
      {
        action: "do_something_else",
        location: "Tokyo",
      },
      TOOL_CONTEXT,
    );

    expect(result.error).toContain("Unknown action");
  });

  it("returns error for missing location", async () => {
    const result = await weatherTool.execute(
      {
        action: "get_weather",
      },
      TOOL_CONTEXT,
    );

    expect(result.error).toContain("Missing required parameter: location");
  });

  it("handles conversation_start event", async () => {
    const context = new MockPluginContext();

    plugin.activate(context);
    context.clearLogs();

    await context.emitEvent("conversation_start", { conversationId: "conversation-1" });

    expect(context.logs.some((entry) => entry.message === "Weather plugin activated for conversation")).toBe(
      true,
    );
  });

  it("logs activation", () => {
    const context = new MockPluginContext();

    plugin.activate(context);

    expect(context.logs.some((entry) => entry.message === "Weather plugin loaded successfully")).toBe(true);
  });

  it("weather data has expected structure", () => {
    const weather = getMockWeather("Lisbon", "metric");
    const forecast = getMockForecast("Lisbon", "metric", 2);

    expect(weather).toEqual(
      expect.objectContaining({
        location: "Lisbon",
        units: "metric",
        condition: expect.any(String),
        temperature: expect.any(Number),
        humidity: expect.any(Number),
        windSpeed: expect.any(Number),
        description: expect.any(String),
      }),
    );

    expect(forecast).toEqual(
      expect.objectContaining({
        location: "Lisbon",
        units: "metric",
        days: expect.any(Array),
      }),
    );
    expect(forecast.days).toHaveLength(2);
    expect(forecast.days[0]).toEqual(
      expect.objectContaining({
        date: expect.any(String),
        high: expect.any(Number),
        low: expect.any(Number),
        condition: expect.any(String),
        precipChance: expect.any(Number),
      }),
    );
  });

  it("supports metric and imperial units", async () => {
    const metric = await weatherTool.execute(
      {
        action: "get_weather",
        location: "Paris",
        units: "metric",
      },
      TOOL_CONTEXT,
    );

    const imperial = await weatherTool.execute(
      {
        action: "get_weather",
        location: "Paris",
        units: "imperial",
      },
      TOOL_CONTEXT,
    );

    const metricData = metric.result as { data: { temperature: number; units: string } };
    const imperialData = imperial.result as { data: { temperature: number; units: string } };

    expect(metricData.data.units).toBe("metric");
    expect(imperialData.data.units).toBe("imperial");
    expect(metricData.data.temperature).not.toBe(imperialData.data.temperature);
  });

  it("deactivate is callable", () => {
    expect(() => plugin.deactivate?.()).not.toThrow();
  });
});
