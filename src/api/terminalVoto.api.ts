// Cliente HTTP para enviar handshakes a las Terminales de Voto del mismo punto.
//
// Cada Terminal de Voto corre un sidecar (Express + ws) en :8090. El jurado
// le hace POST /handshake con { votanteId, sesionToken } y la terminal entra
// en sesión.
//
// EN DEV: todas las Terminales de Voto del puesto pueden estar corriendo en
// localhost con puertos distintos. En `terminales` del deployment.yml cada
// terminal tiene una URL local asignada para esto (TODO: extender el
// deployment.yml con `urlLocal` o similar; por ahora derivamos del id).
//
// EN PROD: el DNS interno del puesto resuelve cada terminal a su IP local.

import axios from "axios";
import type { HandshakePayload } from "../types/voto";

export interface ResultadoHandshake {
    ok: boolean;
    entregadoA?: number;
    error?: string;
}

export async function enviarHandshake(
    terminalUrl: string,
    payload: HandshakePayload
): Promise<ResultadoHandshake> {
    try {
        const r = await axios.post(
            `${terminalUrl.replace(/\/$/, "")}/handshake`,
            payload,
            {
                timeout: 3000,
                headers: { "Content-Type": "application/json" },
            }
        );
        return r.data as ResultadoHandshake;
    } catch (e) {
        const msg =
            e instanceof Error
                ? e.message
                : "Error desconocido enviando handshake.";
        return { ok: false, error: msg };
    }
}

// Mapeo dev: terminalId -> URL local del sidecar de esa terminal.
// En prod este mapeo viene del DNS o del deployment.yml. Por ahora hardcoded
// para arrancar las 3 terminales del ejemplo en puertos consecutivos.
export function urlDeTerminal(terminalId: number): string {
    const env = (
        import.meta.env as unknown as { VITE_TERMINAL_BASE?: string }
    ).VITE_TERMINAL_BASE;
    const base = env?.trim() || "http://localhost";
    // Por convención dev: terminal 1 -> 8090, terminal 2 -> 8092, etc.
    const puerto = 8088 + terminalId * 2;
    return `${base}:${puerto}`;
}
