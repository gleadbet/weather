export interface WeatherLocation {
  name: string;
  admin1: string | null;
  countryCode: string | null;
  latitude: number;
  longitude: number;
  label: string;
}

export interface TodayWeather {
  date: string;
  highF: number | null;
  lowF: number | null;
  humidityPct: number | null;
  rainChancePct: number | null;
}

export interface DayForecast {
  date: string;
  highF: number | null;
  lowF: number | null;
  humidityPct: number | null;
  rainChancePct: number | null;
}

export interface WeatherResponse {
  query: string;
  location: WeatherLocation;
  today: TodayWeather;
  forecast: DayForecast[];
  attribution: string;
}
