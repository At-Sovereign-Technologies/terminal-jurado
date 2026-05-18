// Sidecar de la Terminal de Jurado.
//
// Tres roles, todos en el mismo proceso Node:
//
//   1. SERVIDOR WEBSOCKET (:8090) para las Terminales de Voto del puesto.
//      Cada Terminal Voto abre una conexión persistente y se identifica con
//      HELLO. El sidecar usa esa conexión para:
//        - Empujarle HANDSHAKE cuando el jurado autoriza una sesión.
//        - Recibir VOTOS firmados que la Voto envía tras la confirmación.
//
//   2. SERVIDOR WEBSOCKET (:8087) para el SPA del Jurado. El SPA se conecta
//      para recibir eventos en vivo (terminal liberada por voto emitido,
//      cola pendiente, etc.).
//
//   3. CLIENTE HTTP al Nodo de Votación Activa. Cuando llega un voto, lo
//      reenvía al Nodo. Si el Nodo está caído, lo encola localmente en
//      sidecar/cola.json y reintenta cada 10 s.
//
// Atributos de calidad implementados aquí:
//   - Resiliencia: cola persistente a disco + retry automático.
//   - Trazabilidad: cada evento se loguea con terminalId y votanteId.

import express, { type Request, type Response } from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLA_PATH = join(__dirname, "cola.json");

const HTTP_PORT = Number(process.env.SIDECAR_HTTP_PORT ?? 8089);
const WS_VOTO_PORT = Number(process.env.SIDECAR_WS_VOTO_PORT ?? 8090);
const WS_JURADO_PORT = Number(process.env.SIDECAR_WS_JURADO_PORT ?? 8087);
const NODO_URL = process.env.NODO_URL ?? "http://localhost:8080";

interface VotoEnCola {
    id: string;
    terminal: number;
    votante: number;
    payload: unknown; // VotoFirmado serializado
    intentos: number;
    timestamp: number;
}

// ── Estado en memoria ───────────────────────────────────────────────────────

const votoConnections = new Map<number, WebSocket>();
const juradoConnections = new Set<WebSocket>();
let cola: VotoEnCola[] = cargarCola();

// ── Cola persistente ────────────────────────────────────────────────────────

function cargarCola(): VotoEnCola[] {
    if (!existsSync(COLA_PATH)) return [];
    try {
        const raw = readFileSync(COLA_PATH, "utf-8");
        return JSON.parse(raw) as VotoEnCola[];
    } catch (e) {
        console.warn("[jurado-sidecar] cola.json malformado, se reinicia:", e);
        return [];
    }
}

function guardarCola() {
    writeFileSync(COLA_PATH, JSON.stringify(cola, null, 2), "utf-8");
}

// ── Cliente al Nodo ─────────────────────────────────────────────────────────

interface VotoRespuesta {
    ok: boolean;
    numeroConfirmacion?: string;
    motivo?: string;
}

async function reenviarAlNodo(payload: unknown): Promise<VotoRespuesta> {
    try {
        const r = await fetch(`${NODO_URL.replace(/\/$/, "")}/votar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) {
            return { ok: false, motivo: `Nodo respondió HTTP ${r.status}` };
        }
        const data = (await r.json().catch(() => ({}))) as {
            numeroConfirmacion?: string;
        };
        return {
            ok: true,
            numeroConfirmacion:
                data.numeroConfirmacion ?? `VC-${Date.now().toString(36).toUpperCase()}`,
        };
    } catch (e) {
        return {
            ok: false,
            motivo: e instanceof Error ? e.message : "Error contactando al Nodo",
        };
    }
}

// ── Worker de retry de la cola ──────────────────────────────────────────────

async function drenarCola() {
    if (cola.length === 0) return;
    const pendientes = [...cola];
    for (const item of pendientes) {
        const r = await reenviarAlNodo(item.payload);
        if (r.ok) {
            cola = cola.filter((x) => x.id !== item.id);
            guardarCola();
            console.info(
                "[jurado-sidecar] cola: voto %s entregado al Nodo (intentos=%d)",
                item.id,
                item.intentos + 1
            );
            avisarJurado({
                tipo: "EVENTO_TERMINAL",
                terminalId: item.terminal,
                votanteId: item.votante,
                eventoTipo: "VOTO_EMITIDO",
            });
        } else {
            item.intentos++;
            guardarCola();
        }
    }
}

setInterval(drenarCola, 10_000);

// ── WebSocket de Terminales Voto ────────────────────────────────────────────

const wsVoto = new WebSocketServer({ port: WS_VOTO_PORT });
wsVoto.on("connection", (ws) => {
    let terminalIdLocal: number | null = null;

    ws.send(JSON.stringify({ tipo: "WELCOME", mensaje: "Sidecar Jurado." }));

    ws.on("message", async (data) => {
        let msg: { tipo: string; [k: string]: unknown };
        try {
            msg = JSON.parse(String(data));
        } catch {
            return;
        }

        if (msg.tipo === "HELLO") {
            const tid = Number(msg.terminalId);
            if (!Number.isFinite(tid)) return;
            terminalIdLocal = tid;
            votoConnections.set(tid, ws);
            console.info(
                "[jurado-sidecar] HELLO de Terminal Voto #%d (activas: %d)",
                tid,
                votoConnections.size
            );
            return;
        }

        if (msg.tipo === "VOTO") {
            const payload = msg.payload as {
                voto?: { terminal?: number; votante?: number };
            };
            const terminal = payload?.voto?.terminal ?? 0;
            const votante = payload?.voto?.votante ?? 0;
            console.info(
                "[jurado-sidecar] VOTO recibido terminal=%d votante=%d",
                terminal,
                votante
            );

            const r = await reenviarAlNodo(payload);
            if (r.ok) {
                ws.send(
                    JSON.stringify({
                        tipo: "VOTO_ACEPTADO",
                        numeroConfirmacion: r.numeroConfirmacion,
                    })
                );
                avisarJurado({
                    tipo: "EVENTO_TERMINAL",
                    terminalId: terminal,
                    votanteId: votante,
                    eventoTipo: "VOTO_EMITIDO",
                });
            } else {
                // Nodo caído: encolamos y respondemos al votante con número
                // provisional. La cola se reintentará en background.
                const id = `${Date.now()}-${terminal}-${votante}`;
                const numeroProvisional = `VC-OFF-${Date.now().toString(36).toUpperCase()}`;
                cola.push({
                    id,
                    terminal,
                    votante,
                    payload,
                    intentos: 0,
                    timestamp: Date.now(),
                });
                guardarCola();
                console.warn(
                    "[jurado-sidecar] Nodo no responde (%s). Voto %s encolado.",
                    r.motivo,
                    id
                );
                ws.send(
                    JSON.stringify({
                        tipo: "VOTO_ACEPTADO",
                        numeroConfirmacion: numeroProvisional,
                    })
                );
                avisarJurado({
                    tipo: "EVENTO_TERMINAL",
                    terminalId: terminal,
                    votanteId: votante,
                    eventoTipo: "VOTO_EMITIDO",
                });
            }
        }
    });

    ws.on("close", () => {
        if (terminalIdLocal !== null) {
            const actual = votoConnections.get(terminalIdLocal);
            if (actual === ws) votoConnections.delete(terminalIdLocal);
            console.info(
                "[jurado-sidecar] Terminal Voto #%d desconectada",
                terminalIdLocal
            );
        }
    });
});

// ── WebSocket del SPA del Jurado ────────────────────────────────────────────

const wsJurado = new WebSocketServer({ port: WS_JURADO_PORT });
wsJurado.on("connection", (ws) => {
    juradoConnections.add(ws);
    ws.send(
        JSON.stringify({
            tipo: "WELCOME",
            colaPendiente: cola.length,
        })
    );
    ws.on("close", () => juradoConnections.delete(ws));
});

function avisarJurado(payload: object) {
    const json = JSON.stringify(payload);
    juradoConnections.forEach((ws) => {
        if (ws.readyState === ws.OPEN) ws.send(json);
    });
}

// ── HTTP: el SPA del Jurado empuja handshakes ───────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
const httpServer = createServer(app);

app.post("/handshake", (req: Request, res: Response) => {
    const { terminalId, votanteId, sesionToken } = req.body ?? {};
    if (
        !Number.isFinite(terminalId) ||
        !Number.isFinite(votanteId) ||
        typeof sesionToken !== "string"
    ) {
        return res.status(400).json({
            error: "Payload inválido. Esperado: { terminalId, votanteId, sesionToken }",
        });
    }
    const ws = votoConnections.get(terminalId);
    if (!ws || ws.readyState !== ws.OPEN) {
        return res.status(503).json({
            error: `Terminal Voto #${terminalId} no está conectada al sidecar.`,
        });
    }
    ws.send(
        JSON.stringify({
            tipo: "HANDSHAKE",
            votanteId,
            sesionToken,
        })
    );
    console.info(
        "[jurado-sidecar] HANDSHAKE → Terminal Voto #%d (votante %d)",
        terminalId,
        votanteId
    );
    return res.json({ ok: true });
});

// Endpoint legacy /eventos: para tests manuales con curl simulando un
// VOTO_EMITIDO sin pasar por una Terminal Voto real.
app.post("/eventos", (req: Request, res: Response) => {
    const { tipo, terminalId, votanteId } = req.body ?? {};
    if (
        (tipo !== "VOTO_EMITIDO" && tipo !== "SESION_CANCELADA") ||
        typeof terminalId !== "number"
    ) {
        return res.status(400).json({ error: "Payload inválido." });
    }
    avisarJurado({
        tipo: "EVENTO_TERMINAL",
        terminalId,
        votanteId,
        eventoTipo: tipo,
    });
    return res.json({ ok: true });
});

app.get("/health", (_req, res) =>
    res.json({
        ok: true,
        ts: Date.now(),
        terminalesConectadas: Array.from(votoConnections.keys()),
        colaPendiente: cola.length,
    })
);

httpServer.listen(HTTP_PORT, () => {
    console.info(`[jurado-sidecar] HTTP        → http://localhost:${HTTP_PORT}`);
    console.info(`[jurado-sidecar] WS Voto     → ws://localhost:${WS_VOTO_PORT}`);
    console.info(`[jurado-sidecar] WS Jurado   → ws://localhost:${WS_JURADO_PORT}`);
    console.info(`[jurado-sidecar] Nodo URL    → ${NODO_URL}`);
    if (cola.length > 0) {
        console.warn(
            "[jurado-sidecar] Cola al arrancar: %d votos pendientes (cola.json).",
            cola.length
        );
    }
});
