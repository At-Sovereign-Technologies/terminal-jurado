// Cliente HTTP del Nodo de Votación Activa, desde la Terminal de Jurado.

import axios, { type AxiosInstance } from "axios";
import type { RespuestaVotanteIdentidad } from "../types/voto";

export interface NodoClient {
    consultarVotante(documento: string): Promise<RespuestaVotanteIdentidad>;
    consultarEstadoPuesto(): Promise<EstadoPuestoRespuesta>;
}

// Respuesta de GET /puesto. Solo nos importan los flags `activo` para
// el polling de revocación. Las terminales devueltas también permiten
// detectar si una máquina del punto fue marcada como inactiva.
export interface EstadoPuestoRespuesta {
    punto: {
        id: number;
        activo: boolean;
        terminales: Array<{ id: number; activo: boolean }>;
    };
}

export function crearNodoClient(opts: {
    clusterUrl: string;
    secreto: string;
}): NodoClient {
    const http: AxiosInstance = axios.create({
        baseURL: opts.clusterUrl.replace(/\/$/, ""),
        timeout: 5000,
        headers: {
            Authorization: `Bearer ${opts.secreto}`,
            "Content-Type": "application/json",
        },
    });

    return {
        async consultarVotante(documento) {
            const r = await http.get<RespuestaVotanteIdentidad>(
                `/votante/${encodeURIComponent(documento)}`
            );
            return r.data;
        },

        async consultarEstadoPuesto() {
            const r = await http.get<EstadoPuestoRespuesta>("/puesto");
            return r.data;
        },
    };
}
