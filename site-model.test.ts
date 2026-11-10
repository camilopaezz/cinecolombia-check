import { describe, it, expect } from "bun:test";
import { catalogGroups } from "./site-model";
import type { FilmRecord, State } from "./domain";
const film: FilmRecord = { id: "A", title: "Film", shortSynopsis: "", releaseDate: "2026-07-02",
  runtimeInMinutes: null, censorRating: "", genres: [], director: "", webUrl: "", posterUrl: null,
  categories: ["NowShowing"], availabilityRows: [{ siteId: null, categories: ["NowShowing"] }] };
const state: State = { films: [film], tmdbCache: {}, lastRun: "2026-07-01T18:00:00Z" };
describe("catalog presentation", () => {
  it("uses the catalog change date and flags future NowShowing without claiming showtimes", () => {
    const groups = catalogGroups(state);
    expect(groups[0]?.title).toBe("Próximos estrenos");
    expect(groups[0]?.films[0]?.notes.join(" ")).toContain("no confirma funciones");
    expect(catalogGroups(state, new Date("2026-07-03T18:00:00Z"))[0]?.title).toBe("Cartelera reportada");
  });
  it("distinguishes national rows, legacy records, missing rows, and soft-missing films", () => {
    const { availabilityRows: _rows, ...legacy } = film;
    const groups = catalogGroups({ ...state, films: [
      { ...film, releaseDate: null }, { ...legacy, id: "B", releaseDate: null },
      { ...film, id: "C", availabilityRows: [] }, { ...film, id: "D" },
    ], missingRuns: { D: 1 } });
    expect(groups.find(g => g.title === "Cartelera reportada")?.films.map(f => f.film.id)).toEqual(["A", "B"]);
    const uncertain = groups.find(g => g.title === "Disponibilidad sin confirmar")!;
    expect(uncertain.films.map(f => f.film.id)).toEqual(["C", "D"]);
    expect(uncertain.films[0]?.notes.join(" ")).toContain("Sin filas");
    expect(uncertain.films[1]?.notes.join(" ")).toContain("1 ausencia");
  });
});
