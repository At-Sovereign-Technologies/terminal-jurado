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
import { parse as parseYaml } from "yaml";
import * as ed from "@noble/ed25519";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLA_PATH = join(__dirname, "cola.json");
const DEPLOYMENT_PATH = join(__dirname, "..", "public", "deployment.yml");
const JURADO_CONFIG_PATH = join(__dirname, "..", "public", "jurado-config.json");

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

// ── Carga de deployment + config para validar HELLOs y firmas ──────────────

interface TerminalAutorizada {
    id: number;
    secreto: string;
    clavePublica: string; // Ed25519 hex, para verificar firmas de votos
    activo: boolean;
}

interface PuntoCargado {
    id: number;
    activo: boolean;
    terminales: TerminalAutorizada[];
}

function cargarPunto(): PuntoCargado | null {
    if (!existsSync(DEPLOYMENT_PATH) || !existsSync(JURADO_CONFIG_PATH)) {
        console.warn(
            "[jurado-sidecar] deployment.yml o jurado-config.json no encontrados; el sidecar arranca en modo PERMISIVO (no valida HELLO ni firmas)."
        );
        return null;
    }
    try {
        const yaml = parseYaml(readFileSync(DEPLOYMENT_PATH, "utf-8")) as {
            puntos?: Array<{
                id: number;
                activo: boolean;
                terminales: Array<{
                    id: number;
                    secreto?: string;
                    clavePublica?: string;
                    activo: boolean;
                }>;
            }>;
        };
        const cfg = JSON.parse(
            readFileSync(JURADO_CONFIG_PATH, "utf-8")
        ) as { puntoId: number };
        const punto = yaml.puntos?.find((p) => p.id === cfg.puntoId);
        if (!punto) {
            console.warn(
                "[jurado-sidecar] puntoId %d no encontrado en deployment.yml; modo PERMISIVO.",
                cfg.puntoId
            );
            return null;
        }
        return {
            id: punto.id,
            activo: punto.activo,
            terminales: punto.terminales.map((t) => ({
                id: t.id,
                secreto: t.secreto ?? "",
                clavePublica: t.clavePublica ?? "",
                activo: t.activo,
            })),
        };
    } catch (e) {
        console.warn(
            "[jurado-sidecar] error cargando deployment/config:",
            e,
            "→ modo PERMISIVO."
        );
        return null;
    }
}

// `punto` se reasigna cada 30s al releer el deployment.yml. Si el Servidor
// Electoral marcó terminales como inactivas, el watcher las desconecta.
let punto = cargarPunto();
const PUNTO_REFRESH_MS = Number(process.env.PUNTO_REFRESH_MS ?? 30_000);

setInterval(() => {
    const anterior = punto;
    const nuevo = cargarPunto();
    punto = nuevo;
    if (!anterior || !nuevo) return;
    // Si alguna terminal pasó de activo:true → activo:false, cerramos su WS.
    for (const tNuevo of nuevo.terminales) {
        const tAnterior = anterior.terminales.find((t) => t.id === tNuevo.id);
        if (!tAnterior) continue;
        if (tAnterior.activo && !tNuevo.activo) {
            const ws = votoConnections.get(tNuevo.id);
            if (ws) {
                console.warn(
                    "[jurado-sidecar] Terminal Voto #%d revocada en caliente. Cerrando WebSocket.",
                    tNuevo.id
                );
                try {
                    ws.send(
                        JSON.stringify({
                            tipo: "VOTO_RECHAZADO",
                            motivo: "Terminal revocada por el Servidor Electoral.",
                        })
                    );
                } catch {
                    /* socket ya cerrado */
                }
                ws.close();
            }
            avisarJurado({
                tipo: "TERMINAL_REVOCADA",
                terminalId: tNuevo.id,
            });
        }
    }
    // Si el punto se revoca, cerramos TODAS las conexiones.
    if (anterior.activo && !nuevo.activo) {
        console.warn(
            "[jurado-sidecar] Punto #%d revocado en caliente. Cerrando todas las conexiones.",
            nuevo.id
        );
        votoConnections.forEach((ws, _id) => ws.close());
        votoConnections.clear();
        avisarJurado({ tipo: "PUNTO_REVOCADO" });
    }
}, PUNTO_REFRESH_MS);

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

function rechazar(ws: WebSocket, motivo: string) {
    console.warn("[jurado-sidecar] rechazando conexión:", motivo);
    try {
        ws.send(JSON.stringify({ tipo: "VOTO_RECHAZADO", motivo }));
    } catch {
        /* socket ya cerrado */
    }
    ws.close();
}

// ── Verificación Ed25519 de votos antes de aceptarlos ──────────────────────

// Misma serialización canónica que en terminal-votacion/src/crypto/firmaVoto.ts:
// keys ordenadas alfabéticamente y, si hay preferencias, también ordenadas.
function serializarCanonico(voto: {
    terminal: number;
    votante: number;
    candidato: number;
    preferencias?: Record<string, number>;
}): string {
    let prefs: Record<string, number> | undefined;
    if (voto.preferencias && Object.keys(voto.preferencias).length > 0) {
        prefs = {};
        for (const k of Object.keys(voto.preferencias).sort()) {
            prefs[k] = voto.preferencias[k];
        }
    }
    return JSON.stringify({
        candidato: voto.candidato,
        ...(prefs ? { preferencias: prefs } : {}),
        terminal: voto.terminal,
        votante: voto.votante,
    });
}

function hexAUint8(hex: string): Uint8Array | null {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

async function verificarFirma(payload: {
    voto?: {
        terminal?: number;
        votante?: number;
        candidato?: number;
        preferencias?: Record<string, number>;
    };
    firma?: string;
}): Promise<{ ok: true } | { ok: false; motivo: string }> {
    if (!payload?.voto || typeof payload.firma !== "string") {
        return { ok: false, motivo: "Payload sin voto o firma." };
    }
    const { terminal, votante, candidato } = payload.voto;
    if (!Number.isFinite(terminal) || !Number.isFinite(votante) || !Number.isFinite(candidato)) {
        return { ok: false, motivo: "Campos del voto incompletos." };
    }
    if (!punto) {
        // Modo permisivo (sin deployment cargado): no verificamos firma.
        return { ok: true };
    }
    const term = punto.terminales.find((t) => t.id === terminal);
    if (!term) {
        return {
            ok: false,
            motivo: `Terminal #${terminal} no pertenece al punto.`,
        };
    }
    if (!term.activo) {
        return {
            ok: false,
            motivo: `Terminal #${terminal} marcada como inactiva.`,
        };
    }
    if (!term.clavePublica) {
        // Sin clave pública declarada: no podemos verificar; aceptamos
        // dejando warning. Decisión consciente para no bloquear demo si
        // el deployment.yml no la incluye.
        console.warn(
            "[jurado-sidecar] terminal #%d sin clavePublica; firma NO verificada.",
            terminal
        );
        return { ok: true };
    }
    const firmaBytes = hexAUint8(payload.firma);
    const pubBytes = hexAUint8(term.clavePublica);
    if (!firmaBytes || !pubBytes) {
        return {
            ok: false,
            motivo: "firma o clave pública con formato inválido.",
        };
    }
    const mensaje = new TextEncoder().encode(
        serializarCanonico(payload.voto as {
            terminal: number;
            votante: number;
            candidato: number;
            preferencias?: Record<string, number>;
        })
    );
    try {
        const valida = await ed.verifyAsync(firmaBytes, mensaje, pubBytes);
        return valida
            ? { ok: true }
            : {
                  ok: false,
                  motivo: "Firma Ed25519 inválida para esta terminal.",
              };
    } catch (e) {
        return {
            ok: false,
            motivo:
                e instanceof Error ? e.message : "Error verificando firma.",
        };
    }
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
            notificarCambioCola();
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
            notificarCambioCola();
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
            const secreto = String(msg.secreto ?? "");
            if (!Number.isFinite(tid)) {
                rechazar(ws, "HELLO con terminalId inválido");
                return;
            }
            if (punto) {
                const esperada = punto.terminales.find((t) => t.id === tid);
                if (!esperada) {
                    rechazar(
                        ws,
                        `Terminal #${tid} no pertenece al punto #${punto.id}`
                    );
                    return;
                }
                if (!esperada.activo) {
                    rechazar(
                        ws,
                        `Terminal #${tid} marcada como inactiva por el Servidor Electoral`
                    );
                    return;
                }
                if (esperada.secreto && esperada.secreto !== secreto) {
                    rechazar(
                        ws,
                        `Terminal #${tid}: secreto incorrecto. Conexión rechazada.`
                    );
                    return;
                }
            }
            terminalIdLocal = tid;
            votoConnections.set(tid, ws);
            console.info(
                "[jurado-sidecar] HELLO de Terminal Voto #%d %s(activas: %d)",
                tid,
                punto ? "[validado] " : "[modo permisivo] ",
                votoConnections.size
            );
            return;
        }

        if (msg.tipo === "VOTO") {
            const payload = msg.payload as {
                voto?: {
                    terminal?: number;
                    votante?: number;
                    candidato?: number;
                    preferencias?: Record<string, number>;
                };
                firma?: string;
            };
            const terminal = payload?.voto?.terminal ?? 0;
            const votante = payload?.voto?.votante ?? 0;

            // Validar que la terminal que envía es la misma que se identificó
            // con HELLO en este socket (evita que una terminal A envíe
            // votos pretendiendo ser de la terminal B).
            if (terminalIdLocal !== null && terminal !== terminalIdLocal) {
                ws.send(
                    JSON.stringify({
                        tipo: "VOTO_RECHAZADO",
                        motivo: `Esta conexión está autenticada como Terminal #${terminalIdLocal} pero el voto declara Terminal #${terminal}.`,
                    })
                );
                return;
            }

            // Verificar firma Ed25519 antes de aceptar.
            const verif = await verificarFirma(payload);
            if (!verif.ok) {
                console.warn(
                    "[jurado-sidecar] VOTO rechazado por firma: %s",
                    verif.motivo
                );
                ws.send(
                    JSON.stringify({
                        tipo: "VOTO_RECHAZADO",
                        motivo: `Firma inválida: ${verif.motivo}`,
                    })
                );
                return;
            }

            console.info(
                "[jurado-sidecar] VOTO recibido terminal=%d votante=%d firma OK",
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
            notificarCambioCola();
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

function notificarCambioCola() {
    avisarJurado({ tipo: "COLA_ACTUALIZADA", pendientes: cola.length });
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

// Proxy de consulta de votante al Nodo (el SPA del Jurado no habla
// directamente con el Nodo; todo sale del sidecar).
app.get("/votante/:documento", async (req: Request, res: Response) => {
    const doc = req.params.documento;
    try {
        const r = await fetch(
            `${NODO_URL.replace(/\/$/, "")}/votante/${encodeURIComponent(doc)}`,
            { signal: AbortSignal.timeout(3000) }
        );
        if (!r.ok) {
            return res.json({ votado: false, sinNodo: true });
        }
        const data = (await r.json().catch(() => ({}))) as { votado?: boolean };
        return res.json({ votado: !!data.votado });
    } catch {
        return res.json({ votado: false, sinNodo: true });
    }
});

// Proxy de configuración activa del puesto/electión desde el Nodo.
// El SPA del Jurado la consume al arranque para evitar depender de
// información quemada en archivos locales.
app.get("/puesto", async (_req: Request, res: Response) => {
    try {
        const r = await fetch(`${NODO_URL.replace(/\/$/, "")}/puesto`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) {
            return res.status(r.status).json({
                error: `No se pudo obtener /puesto del Nodo (HTTP ${r.status}).`,
            });
        }
        const data = (await r.json().catch(() => null)) as unknown;
        if (!data || typeof data !== "object") {
            return res
                .status(502)
                .json({ error: "Respuesta inválida del Nodo para /puesto." });
        }
        return res.json(data);
    } catch (e) {
        return res.status(503).json({
            error:
                e instanceof Error
                    ? e.message
                    : "No se pudo contactar al Nodo para /puesto.",
        });
    }
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
