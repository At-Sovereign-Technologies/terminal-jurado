// SE-M3-05 — Cliente para registrar voto asistido.
//
// Esta terminal hace dos cosas al registrar un voto asistido:
//  1. Calcula SHA-256 del documento del acompañante (NUNCA viaja en claro).
//  2. Envía el evento a SR-M6 (transparency-service) con el hash.
//  3. Si todo OK, devuelve el hash para que el handshake al voto lo incluya.
//
// MIENTRAS NO EXISTA el endpoint real del transparency-service consultable
// desde aquí (auth, CORS, etc.), esta implementación es un MOCK que valida
// localmente con una lista de hashes "ya asistidos" en memoria. Cuando
// Augusto exponga el endpoint, se reemplaza por la llamada HTTP real.

import type {
    DatosAsistencia,
    ResultadoRegistroAsistencia,
} from "../types/asistencia";

// Set en memoria que simula la BD de "este acompañante ya asistió a X
// votante no-familiar en la jornada". En prod esto vive en SR-M6.
const acompanantesNoFamiliares = new Set<string>();

async function sha256Hex(texto: string): Promise<string> {
    const bytes = new TextEncoder().encode(texto.trim().toUpperCase());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export async function registrarAsistencia(
    datos: DatosAsistencia
): Promise<ResultadoRegistroAsistencia> {
    const hash = await sha256Hex(datos.documentoAcompanante);

    if (!datos.esFamiliar && acompanantesNoFamiliares.has(hash)) {
        return {
            ok: false,
            motivoRechazo:
                "Este acompañante ya asistió a un votante no-familiar en la jornada. " +
                "El límite legal es 1 por jornada (excepto familiares).",
        };
    }

    if (!datos.esFamiliar) {
        acompanantesNoFamiliares.add(hash);
    }

    // TODO: cuando exista el endpoint, hacer POST a:
    //   {transparencyService}/api/v1/transparency/events
    // con payload Zero-Identity:
    //   {
    //     eventType: "ASISTENCIA_REGISTRADA",
    //     details: {
    //       hashDocAcompanante: hash,
    //       esFamiliar,
    //       tipoAsistencia,
    //       cryptographic_protocol: "SHA-256"
    //     }
    //   }
    console.info(
        "[ASISTENCIA] (mock) registrada hash=%s familiar=%s tipo=%s",
        hash,
        datos.esFamiliar,
        datos.tipoAsistencia
    );

    return { ok: true, hashAcompanante: hash };
}
