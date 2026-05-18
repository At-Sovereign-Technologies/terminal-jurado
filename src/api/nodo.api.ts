// Cliente del sidecar local para consultas que el sidecar proxea al Nodo
// de Votación Activa. El SPA NO habla directo con el Nodo: todo va por el
// sidecar para mantener una sola fuente de salida al exterior.

import axios from "axios";
import type { RespuestaVotanteIdentidad } from "../types/voto";

const SIDECAR_URL =
    (
        import.meta.env as unknown as { VITE_SIDECAR_URL?: string }
    ).VITE_SIDECAR_URL?.trim() || "http://localhost:8089";

export interface NodoClient {
    consultarVotante(documento: string): Promise<RespuestaVotanteIdentidad>;
}

export function crearNodoClient(_opts?: unknown): NodoClient {
    return {
        async consultarVotante(documento) {
            const r = await axios.get<RespuestaVotanteIdentidad>(
                `${SIDECAR_URL.replace(/\/$/, "")}/votante/${encodeURIComponent(documento)}`,
                { timeout: 4000 }
            );
            return r.data;
        },
    };
}
