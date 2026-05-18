import { useEffect, useRef } from "react";
import { crearNodoClient } from "../api/nodo.api";

// Polling al Nodo cada N segundos para detectar:
//   1. Revocación del PUNTO (Servidor Electoral marcó el punto entero como
//      inactivo, por ejemplo por evidencia de fraude masivo). El jurado deja
//      de operar.
//   2. Cambios en `activo` de las terminales de voto del punto, para
//      reflejarlos en la UI sin requerir reinicio del SPA del jurado.

export interface EstadoTerminalRemota {
    id: number;
    activo: boolean;
}

export interface OpcionesPolling {
    clusterUrl: string;
    secreto: string;
    puntoId: number;
    intervaloMs?: number;
    onPuntoRevocado: (motivo: string) => void;
    onTerminalesActualizadas: (terminales: EstadoTerminalRemota[]) => void;
}

const INTERVALO_DEFAULT_MS = 30_000;

export function usePollingRevocacion(opts: OpcionesPolling | null) {
    const onPuntoRevocadoRef = useRef(opts?.onPuntoRevocado);
    const onTerminalesRef = useRef(opts?.onTerminalesActualizadas);
    onPuntoRevocadoRef.current = opts?.onPuntoRevocado;
    onTerminalesRef.current = opts?.onTerminalesActualizadas;

    useEffect(() => {
        if (!opts) return;
        const { clusterUrl, secreto, puntoId } = opts;
        const intervaloMs = opts.intervaloMs ?? INTERVALO_DEFAULT_MS;

        const nodo = crearNodoClient({ clusterUrl, secreto });
        let cancelado = false;
        let fallosConsecutivos = 0;

        const verificar = async () => {
            if (cancelado) return;
            try {
                const r = await nodo.consultarEstadoPuesto();
                fallosConsecutivos = 0;

                if (r.punto.id !== puntoId) return;
                if (!r.punto.activo) {
                    onPuntoRevocadoRef.current?.(
                        "El Servidor Electoral revocó este punto de votación."
                    );
                    return;
                }
                onTerminalesRef.current?.(r.punto.terminales);
            } catch {
                fallosConsecutivos++;
                if (fallosConsecutivos === 3) {
                    console.warn(
                        "[polling] el Nodo de Votación no responde después de 3 intentos. Se sigue intentando."
                    );
                }
            }
        };

        verificar();
        const id = setInterval(verificar, intervaloMs);
        return () => {
            cancelado = true;
            clearInterval(id);
        };
    }, [opts?.clusterUrl, opts?.secreto, opts?.puntoId, opts?.intervaloMs]);
}
