// Cliente HTTP del Nodo de Votación Activa, desde la Terminal de Jurado.
// El jurado lo usa principalmente para `GET /votante/{doc}` (saber si un
// votante ya emitió su voto antes de autorizar una nueva sesión).

import axios, { type AxiosInstance } from "axios";
import type { RespuestaVotanteIdentidad } from "../types/voto";

export interface NodoClient {
    consultarVotante(documento: string): Promise<RespuestaVotanteIdentidad>;
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
    };
}
