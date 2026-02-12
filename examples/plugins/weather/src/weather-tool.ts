import { defineTool } from "@reins/sdk";

import { getMockForecast, getMockWeather } from "./weather-data";

type WeatherAction = "get_weather" | "get_forecast";
type WeatherUnits = "metric" | "imperial";

function readAction(value: unknown): WeatherAction {
  if (value === "get_weather" || value === "get_forecast") {
    return value;
  }

  throw new Error("Unknown action. Use 'get_weather' or 'get_forecast'.");
}

function readLocation(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Missing required parameter: location");
  }

  return value.trim();
}

function readUnits(value: unknown): WeatherUnits {
  if (value === undefined) {
    return "metric";
  }

  if (value === "metric" || value === "imperial") {
    return value;
  }

  throw new Error("Invalid units. Use 'metric' or 'imperial'.");
}

function readForecastDays(value: unknown): number {
  if (value === undefined) {
    return 5;
  }

  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10) {
    return value;
  }

  throw new Error("Invalid days. Use an integer between 1 and 10.");
}

export const weatherTool = defineTool({
  name: "weather",
  description: "Get current weather or multi-day forecast for a location",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get_weather", "get_forecast"],
        description: "Weather action to perform",
      },
      location: {
        type: "string",
        description: "City name, region, or coordinates",
      },
      units: {
        type: "string",
        enum: ["metric", "imperial"],
        description: "Temperature and wind units",
      },
      days: {
        type: "number",
        description: "Forecast length in days (1-10)",
      },
    },
    required: ["action", "location"],
  },
  execute: async (args) => {
    const action = readAction(args.action);
    const location = readLocation(args.location);
    const units = readUnits(args.units);

    if (action === "get_weather") {
      return {
        action,
        data: getMockWeather(location, units),
      };
    }

    const days = readForecastDays(args.days);
    return {
      action,
      data: getMockForecast(location, units, days),
    };
  },
});
