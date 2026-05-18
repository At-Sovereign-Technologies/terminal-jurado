import { describe, expect, it, beforeEach, vi } from "vitest";
import type * as Asistencia from "./asistencia.api";

// El módulo asistencia.api mantiene estado global (Set en memoria). Cada
// test resetea los módulos para arrancar con estado limpio.

let registrarAsistencia: typeof Asistencia.registrarAsistencia;

beforeEach(async () => {
    vi.resetModules();
    const mod = (await import("./asistencia.api")) as typeof Asistencia;
    registrarAsistencia = mod.registrarAsistencia;
});

describe("registrarAsistencia", () => {
    it("acepta un acompañante no-familiar la primera vez", async () => {
        const r = await registrarAsistencia({
            documentoAcompanante: "100000001",
            esFamiliar: false,
            tipoAsistencia: "Discapacidad",
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.hashAcompanante).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it("rechaza el MISMO acompañante no-familiar la segunda vez en la misma jornada", async () => {
        const primero = await registrarAsistencia({
            documentoAcompanante: "100000002",
            esFamiliar: false,
            tipoAsistencia: "EdadAvanzada",
        });
        expect(primero.ok).toBe(true);

        const segundo = await registrarAsistencia({
            documentoAcompanante: "100000002",
            esFamiliar: false,
            tipoAsistencia: "EdadAvanzada",
        });
        expect(segundo.ok).toBe(false);
        if (!segundo.ok) {
            expect(segundo.motivoRechazo).toContain("no-familiar");
        }
    });

    it("permite al MISMO familiar acompañar a múltiples votantes", async () => {
        for (let i = 0; i < 3; i++) {
            const r = await registrarAsistencia({
                documentoAcompanante: "100000003",
                esFamiliar: true,
                tipoAsistencia: "Otra",
            });
            expect(r.ok).toBe(true);
        }
    });

    it("normaliza espacios y mayúsculas: '100000004' === '  100000004  '", async () => {
        const a = await registrarAsistencia({
            documentoAcompanante: "100000004",
            esFamiliar: false,
            tipoAsistencia: "Discapacidad",
        });
        expect(a.ok).toBe(true);

        // Mismo documento con espacios → debe verse como repetido.
        const b = await registrarAsistencia({
            documentoAcompanante: "  100000004  ",
            esFamiliar: false,
            tipoAsistencia: "Discapacidad",
        });
        expect(b.ok).toBe(false);
    });
});
