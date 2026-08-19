export type WeatherSnapshot = {
  location: string;
  temp_c: number | null;
  feels_like_c: number | null;
  humidity_pct: number | null;
  wind_mps: number | null;
  condition: string | null;
  fetched_at: string;
};

/**
 * Current-conditions lookup by city name (free tier). Same-day matches only
 * need "what's it like today," not a forecast, so the simple current-weather
 * endpoint is enough. Returns null (not a throw) on any failure — weather is
 * an enrichment, not a blocker for producing an analysis.
 */
export async function getWeatherForLocation(
  location: string,
): Promise<WeatherSnapshot | null> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey || !location) return null;

  try {
    const url = new URL("https://api.openweathermap.org/data/2.5/weather");
    url.searchParams.set("q", location);
    url.searchParams.set("appid", apiKey);
    url.searchParams.set("units", "metric");

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();

    return {
      location,
      temp_c: data.main?.temp ?? null,
      feels_like_c: data.main?.feels_like ?? null,
      humidity_pct: data.main?.humidity ?? null,
      wind_mps: data.wind?.speed ?? null,
      condition: data.weather?.[0]?.description ?? null,
      fetched_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
