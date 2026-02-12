export interface WeatherData {
  location: string;
  temperature: number;
  units: "metric" | "imperial";
  condition: string;
  humidity: number;
  windSpeed: number;
  description: string;
}

export interface ForecastDay {
  date: string;
  high: number;
  low: number;
  condition: string;
  precipChance: number;
}

export interface ForecastData {
  location: string;
  units: "metric" | "imperial";
  days: ForecastDay[];
}

const CONDITIONS = ["sunny", "cloudy", "rainy", "snowy"] as const;

function hashLocation(location: string): number {
  let hash = 0;
  for (const char of location.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 10_000;
  }
  return hash;
}

function normalizeLocation(location: string): string {
  return location.trim().replace(/\s+/g, " ");
}

function toImperialTemperature(celsius: number): number {
  return Math.round((celsius * 9) / 5 + 32);
}

function toImperialWind(kph: number): number {
  return Number((kph / 1.609).toFixed(1));
}

function asDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getMockWeather(location: string, units: "metric" | "imperial"): WeatherData {
  const normalized = normalizeLocation(location);
  const hash = hashLocation(normalized);
  const condition = CONDITIONS[hash % CONDITIONS.length];

  const baseTempC = 8 + (hash % 20);
  const humidity = 35 + (hash % 55);
  const windKph = 5 + (hash % 30);

  const temperature = units === "metric" ? baseTempC : toImperialTemperature(baseTempC);
  const windSpeed = units === "metric" ? windKph : toImperialWind(windKph);

  const description =
    condition === "sunny"
      ? "Clear skies with good visibility"
      : condition === "cloudy"
        ? "Mostly cloudy with occasional sun"
        : condition === "rainy"
          ? "Light to moderate rain showers"
          : "Cold conditions with possible snowfall";

  return {
    location: normalized,
    temperature,
    units,
    condition,
    humidity,
    windSpeed,
    description,
  };
}

export function getMockForecast(
  location: string,
  units: "metric" | "imperial",
  days: number,
): ForecastData {
  const normalized = normalizeLocation(location);
  const hash = hashLocation(normalized);
  const startTempC = 10 + (hash % 16);

  const forecastDays: ForecastDay[] = [];
  for (let index = 0; index < days; index += 1) {
    const date = new Date();
    date.setDate(date.getDate() + index);

    const highC = startTempC + (index % 4);
    const lowC = highC - (4 + (index % 3));
    const condition = CONDITIONS[(hash + index) % CONDITIONS.length];

    forecastDays.push({
      date: asDateString(date),
      high: units === "metric" ? highC : toImperialTemperature(highC),
      low: units === "metric" ? lowC : toImperialTemperature(lowC),
      condition,
      precipChance: 10 + ((hash + index * 13) % 70),
    });
  }

  return {
    location: normalized,
    units,
    days: forecastDays,
  };
}
