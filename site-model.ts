import type { FilmRecord, State } from "./domain";

export function bogotaWhen(iso: string) {
  const date = new Date(iso);
  return {
    date: new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "short", year: "numeric" }).format(date),
    time: new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit" }).format(date),
  };
}

/** Classify against the last catalog change, so quiet builds never reclassify at midnight. */
export function catalogGroups(state: State, asOf = state.lastRun ? new Date(state.lastRun) : new Date(0)) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(asOf);
  const groups: { title: string; films: { film: FilmRecord; future: boolean }[] }[] = [
    { title: "Cartelera", films: [] }, { title: "Preventa", films: [] },
    { title: "Próximos estrenos", films: [] }, { title: "Disponibilidad sin confirmar", films: [] },
  ];
  for (const film of state.films) {
    const future = !!film.releaseDate && film.releaseDate.slice(0, 10) > today;
    const misses = state.missingRuns?.[film.id] ?? 0;
    const uncertain = misses > 0 || film.availabilityRows?.length === 0;
    const isNow = film.categories.includes("NowShowing");
    const group = uncertain ? groups[3]! : future && isNow ? groups[2]! : isNow ? groups[0]!
      : film.categories.includes("AdvanceBooking") ? groups[1]!
      : film.categories.includes("ComingSoon") || future ? groups[2]! : groups[3]!;
    group.films.push({ film, future });
  }
  groups.forEach(g => g.films.sort((a, b) => a.film.title.localeCompare(b.film.title, "es") || a.film.id.localeCompare(b.film.id)));
  return groups.filter(g => g.films.length);
}
