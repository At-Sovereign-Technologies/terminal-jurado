// Cliente del WebSocket de eventos del sidecar de la Terminal de Jurado.
// El sidecar emite varios tipos de mensajes en vivo al SPA:
//   - EVENTO_TERMINAL  : voto emitido o sesión cancelada en una terminal.
//   - COLA_ACTUALIZADA : cambió el número de votos pendientes en la cola offline.
//   - PUNTO_REVOCADO   : el Servidor Electoral revocó el punto entero.
//   - TERMINAL_REVOCADA: una terminal específica fue revocada en caliente.
//   - WELCOME          : sidecar acaba de conectar; trae colaPendiente.

import type { EventoTerminalVoto } from "../types/voto";

const WS_URL =
    (typeof window !== "undefined" &&
        (window as unknown as { __SIDECAR_WS_URL__?: string })
            .__SIDECAR_WS_URL__) ||
    "ws://localhost:8087";

interface MensajeWelcome {
    tipo: "WELCOME";
    mensaje?: string;
    colaPendiente?: number;
}

interface MensajeEventoTerminal {
    tipo: "EVENTO_TERMINAL";
    terminalId: number;
    votanteId?: number;
    eventoTipo: EventoTerminalVoto["tipo"];
}

interface MensajeColaActualizada {
    tipo: "COLA_ACTUALIZADA";
    pendientes: number;
}

interface MensajePuntoRevocado {
    tipo: "PUNTO_REVOCADO";
}

interface MensajeTerminalRevocada {
    tipo: "TERMINAL_REVOCADA";
    terminalId: number;
}

type Mensaje =
    | MensajeWelcome
    | MensajeEventoTerminal
    | MensajeColaActualizada
    | MensajePuntoRevocado
    | MensajeTerminalRevocada;

export interface ManejadoresSidecar {
    onEventoTerminal?: (e: EventoTerminalVoto) => void;
    onColaActualizada?: (pendientes: number) => void;
    onPuntoRevocado?: () => void;
    onTerminalRevocada?: (terminalId: number) => void;
}

export interface SuscripcionSidecar {
    cerrar: () => void;
}

export function subscribirseSidecar(
    manejadores: ManejadoresSidecar
): SuscripcionSidecar {
    let ws: WebSocket | null = null;
    let reintento: ReturnType<typeof setTimeout> | null = null;
    let cerrado = false;

    const conectar = () => {
        if (cerrado) return;
        try {
            ws = new WebSocket(WS_URL);
        } catch {
            programarReintento();
            return;
        }

        ws.addEventListener("message", (ev) => {
            try {
                const msg = JSON.parse(String(ev.data)) as Mensaje;
                switch (msg.tipo) {
                    case "WELCOME":
                        if (
                            typeof msg.colaPendiente === "number" &&
                            manejadores.onColaActualizada
                        ) {
                            manejadores.onColaActualizada(msg.colaPendiente);
                        }
                        break;
                    case "EVENTO_TERMINAL":
                        manejadores.onEventoTerminal?.({
                            tipo: msg.eventoTipo,
                            terminalId: msg.terminalId,
                            votanteId: msg.votanteId,
                        });
                        break;
                    case "COLA_ACTUALIZADA":
                        manejadores.onColaActualizada?.(msg.pendientes);
                        break;
                    case "PUNTO_REVOCADO":
                        manejadores.onPuntoRevocado?.();
                        break;
                    case "TERMINAL_REVOCADA":
                        manejadores.onTerminalRevocada?.(msg.terminalId);
                        break;
                }
            } catch {
                /* ignorar mensajes mal formados */
            }
        });

        ws.addEventListener("close", () => {
            if (!cerrado) programarReintento();
        });
    };

    const programarReintento = () => {
        if (reintento || cerrado) return;
        reintento = setTimeout(() => {
            reintento = null;
            conectar();
        }, 2_000);
    };

    conectar();

    return {
        cerrar: () => {
            cerrado = true;
            if (reintento) clearTimeout(reintento);
            ws?.close();
        },
    };
}

// Alias retro-compatible para el código existente.
export function subscribirseAEventosTerminal(
    onEvento: (e: EventoTerminalVoto) => void
): SuscripcionSidecar {
    return subscribirseSidecar({ onEventoTerminal: onEvento });
}
