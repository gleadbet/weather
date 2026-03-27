import { HttpClient, HttpParams } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";
import type { WeatherResponse } from "./weather.models";

/** Calls the Node `/api/weather` route (proxied to port 3000 during `ng serve`). */
@Injectable({ providedIn: "root" })
export class WeatherService {
  private readonly http = inject(HttpClient);

  /**
   * @param location Raw user text (city, optional state, or US ZIP); sent as `q`.
   */
  getWeather(location: string): Observable<WeatherResponse> {
    const params = new HttpParams().set("q", location.trim());
    return this.http.get<WeatherResponse>("/api/weather", { params });
  }
}
