// Cliente HTTP para empujar handshakes a las Terminales de Voto.
//
// El SPA del Jurado llama al SU PROPIO sidecar (http://localhost:8089) y
// le indica a qué Terminal Voto dirigirlo. El sidecar mantiene los
// WebSockets persistentes con cada Terminal Voto del puesto y se encarga
// de empujar el HANDSHAKE por el canal correcto.
//
// Configurable vía VITE_SIDECAR_URL para producción.

import axios from "axios";
import type { HandshakePayload } from "../types/voto";

const SIDECAR_URL =
    (
        import.meta.env as unknown as { VITE_SIDECAR_URL?: string }
    ).VITE_SIDECAR_URL?.trim() || "http://localhost:8089";

export interface ResultadoHandshake {
    ok: boolean;
    error?: string;
}

export async function enviarHandshake(
    terminalId: number,
    payload: HandshakePayload
): Promise<ResultadoHandshake> {
    try {
        const r = await axios.post(
            `${SIDECAR_URL.replace(/\/$/, "")}/handshake`,
            {
                terminalId,
                votanteId: payload.votanteId,
                sesionToken: payload.sesionToken,
            },
            {
                timeout: 3000,
                headers: { "Content-Type": "application/json" },
            }
        );
        return r.data as ResultadoHandshake;
    } catch (e) {
        const msg =
            axios.isAxiosError(e) && e.response?.data?.error
                ? e.response.data.error
                : e instanceof Error
                  ? e.message
                  : "Error desconocido enviando handshake.";
        return { ok: false, error: msg };
    }
}
