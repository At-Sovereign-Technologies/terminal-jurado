// Cliente del sidecar de la Terminal de Jurado.
// El sidecar escucha en :8089 (HTTP) y :8087 (WebSocket) y recibe eventos
// que las Terminales de Voto le mandan vía `parent_url` cuando un votante
// termina su sesión (VOTO_EMITIDO o SESION_CANCELADA).

import type { EventoTerminalVoto } from "../types/voto";

const WS_URL =
    (typeof window !== "undefined" &&
        (window as unknown as { __SIDECAR_WS_URL__?: string })
            .__SIDECAR_WS_URL__) ||
    "ws://localhost:8087";

interface MensajeWelcome {
    tipo: "WELCOME";
    mensaje?: string;
}

interface MensajeEvento {
    tipo: "EVENTO_TERMINAL";
    terminalId: number;
    votanteId?: number;
    eventoTipo: EventoTerminalVoto["tipo"];
}

type Mensaje = MensajeWelcome | MensajeEvento;

export interface SuscripcionSidecar {
    cerrar: () => void;
}

export function subscribirseAEventosTerminal(
    onEvento: (e: EventoTerminalVoto) => void
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
                if (msg.tipo === "EVENTO_TERMINAL") {
                    onEvento({
                        tipo: msg.eventoTipo,
                        terminalId: msg.terminalId,
                        votanteId: msg.votanteId,
                    });
                }
            } catch {
                /* ignorar */
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
