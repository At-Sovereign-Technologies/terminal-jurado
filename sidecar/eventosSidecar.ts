// Sidecar HTTP local de la Terminal de Jurado.
//
// PROBLEMA: el SPA del jurado no puede recibir HTTP entrante directamente,
// pero las Terminales de Voto le hacen POST /eventos a su parent_url cuando
// terminan una sesión.
//
// SOLUCIÓN dev: este proceso Node corre paralelo al SPA. Escucha POST en
// :8089/eventos y reenvía cada evento al SPA por WebSocket :8087.
//
// PROD: cuando el equipo decida (Electron / Tauri / launcher empaquetado),
// se reemplaza este archivo manteniendo el contrato del WebSocket.

import express, { type Request, type Response } from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const HTTP_PORT = Number(process.env.SIDECAR_HTTP_PORT ?? 8089);
const WS_PORT = Number(process.env.SIDECAR_WS_PORT ?? 8087);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ port: WS_PORT });

console.log(`[jurado-sidecar] HTTP → http://localhost:${HTTP_PORT}`);
console.log(`[jurado-sidecar] WS   → ws://localhost:${WS_PORT}`);

wss.on("connection", (ws) => {
    console.log("[jurado-sidecar] SPA del jurado conectado al WS");
    ws.send(JSON.stringify({ tipo: "WELCOME", mensaje: "Sidecar conectado." }));
});

function difundir(payload: object) {
    const json = JSON.stringify(payload);
    let entregados = 0;
    wss.clients.forEach((ws) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(json);
            entregados++;
        }
    });
    return entregados;
}

// Endpoint que llama cada Terminal de Voto cuando el votante termina.
app.post("/eventos", (req: Request, res: Response) => {
    const { tipo, terminalId, votanteId } = req.body ?? {};
    if (
        (tipo !== "VOTO_EMITIDO" && tipo !== "SESION_CANCELADA") ||
        typeof terminalId !== "number"
    ) {
        return res.status(400).json({
            error: "Payload inválido. Esperado: { tipo: VOTO_EMITIDO|SESION_CANCELADA, terminalId: number, votanteId?: number }",
        });
    }
    const entregados = difundir({
        tipo: "EVENTO_TERMINAL",
        terminalId,
        votanteId,
        eventoTipo: tipo,
    });
    console.log(
        `[jurado-sidecar] evento tipo=${tipo} terminalId=${terminalId} votanteId=${votanteId} entregadoA=${entregados} SPA(s)`
    );
    return res.status(200).json({ ok: true, entregadoA: entregados });
});

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

httpServer.listen(HTTP_PORT, () => {
    console.log(`[jurado-sidecar] listo. Prueba simulando voto emitido:
  curl -X POST http://localhost:${HTTP_PORT}/eventos \\
    -H 'Content-Type: application/json' \\
    -d '{"tipo":"VOTO_EMITIDO","terminalId":1,"votanteId":101}'`);
});
