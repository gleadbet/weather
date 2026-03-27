import { Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { CommonModule } from "@angular/common";
import { WeatherService } from "./weather.service";
import type { WeatherResponse } from "./weather.models";

/** Single-page weather lookup: binds the search box to {@link WeatherService}. */
@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent {
  private readonly weatherApi = inject(WeatherService);

  locationInput = "";
  loading = false;
  error: string | null = null;
  result: WeatherResponse | null = null;

  /** Validates input, clears prior state, loads `/api/weather?q=…`. */
  search(): void {
    const q = this.locationInput.trim();
    if (!q) {
      this.error = "Enter a city or ZIP code.";
      return;
    }
    this.loading = true;
    this.error = null;
    this.result = null;

    this.weatherApi.getWeather(q).subscribe({
      next: (data) => {
        this.result = data;
        this.loading = false;
      },
      error: (err) => {
        const msg =
          err?.error?.error ??
          err?.message ??
          "Could not load weather. Is the API server running?";
        this.error = typeof msg === "string" ? msg : "Request failed.";
        this.loading = false;
      },
    });
  }

  /** Rounds °F for display; null/NaN → em dash. */
  formatTemp(v: number | null): string {
    if (v === null || v === undefined || Number.isNaN(v)) {
      return "—";
    }
    return `${Math.round(v)}°F`;
  }

  /** Rounds percent for humidity / rain chance. */
  formatPct(v: number | null): string {
    if (v === null || v === undefined || Number.isNaN(v)) {
      return "—";
    }
    return `${Math.round(v)}%`;
  }

  /**
   * Parses a forecast `date` from the API (calendar day only, no time zone offset).
   * We build a UTC midnight instant so formatting with `timeZone: "UTC"` keeps the
   * displayed weekday and date aligned with that string (avoids local TZ shifting the day).
   */
  private parseForecastUtcDate(isoDate: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
    if (!m) {
      return null;
    }
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  /** First column of the 7-day table: short weekday, browser locale. Invalid input → em dash. */
  formatForecastWeekday(isoDate: string): string {
    const d = this.parseForecastUtcDate(isoDate);
    if (!d) {
      return "—";
    }
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      timeZone: "UTC",
    }).format(d);
  }

  /** Second column: calendar date without weekday. Invalid input echoes the raw string. */
  formatForecastCalendarDate(isoDate: string): string {
    const d = this.parseForecastUtcDate(isoDate);
    if (!d) {
      return isoDate;
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(d);
  }
}
