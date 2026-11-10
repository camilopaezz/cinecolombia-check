export type EventType = "added" | "preventa-opens" | "now-in-theaters" | "removed";

export interface AvailabilityRow {
  siteId: string | null;
  categories: string[];
  showtimeAttributeIds?: string[];
}

export interface FilmRecord {
  id: string;
  title: string;
  shortSynopsis: string;
  releaseDate: string | null;
  runtimeInMinutes: number | null;
  censorRating: string;
  genres: string[];
  director: string;
  webUrl: string;
  categories: string[]; // raw union of observed site categories; not a lifecycle status
  availabilityRows?: AvailabilityRow[]; // absent on records persisted before this field existed
  posterUrl: string | null;
  tmdb?: { tmdbId: number; posterPath: string | null };
}

export interface Event {
  guid: string;
  type: EventType;
  filmId: string;
  createdAt: string; // ISO-8601 UTC
  snapshot: FilmRecord;
}

export interface State {
  films: FilmRecord[];
  tmdbCache: Record<string, { tmdbId: number; posterPath: string | null }>;
  /** Consecutive runs a film was absent while still soft-kept in `films`. */
  missingRuns?: Record<string, number>;
  /** One observed absence per category; the next observed absence confirms the loss. */
  pendingCategoryLosses?: Record<string, Partial<Record<"AdvanceBooking" | "NowShowing", number>>>;
  lastRun?: string; // last meaningful change, not the most recent fetch
}

export interface PostArchive {
  posts: Event[];
  pendingNotificationIds?: string[];
}

