# Terminal de Jurado — Sello Legítimo

SPA web para la **Terminal de Jurado** (TJ) de un puesto electoral. Forma parte
del sistema Sello Legítimo, sub-sistema **Sistema Electoral (SE)**.

Es la consola del jurado en cada puesto. Identifica al votante, verifica contra
el Nodo que no haya votado, selecciona una Terminal de Voto libre del mismo puesto
y le envía un handshake para iniciar la sesión.

## Arquitectura

```
┌─────────────────────┐
│  Servidor Electoral │ ──▶ genera deployment.yml + jurado-config.json
└─────────────────────┘
                       ↓ (distribución física a la máquina del jurado)
                ┌──────────────────────┐
                │   Terminal Jurado    │
                │   (este SPA)         │
                └──┬──────────┬────────┘
                   │          │ POST /handshake
                   │          │  (autorizar sesión)
                   │          ↓
                   │      ┌────────────────────┐
                   │      │  Terminal Voto     │
                   │      │  (mismo puesto)    │
                   │      └─────┬──────────────┘
                   │            │ POST /eventos
                   │            │   (VOTO_EMITIDO)
                   │            ↓
                   │      ┌────────────────────────────────┐
                   │      │ Sidecar Jurado (Express + ws)  │
                   │      │ :8089 HTTP   :8087 WebSocket   │
                   │      └────────────┬───────────────────┘
                   │                   │ WS push
                   │                   ↓
                   │           [el SPA libera la terminal]
                   ↓
              GET /votante/{doc}
              al Nodo de Votación Activa
                   ↓
              ¿este votante ya votó?
```

## Stack

- Vite + React 18 + TypeScript
- Tailwind CSS 3
- `axios` para HTTP al Nodo y a las Terminales de Voto
- `yaml` para parsear `deployment.yml`
- Sidecar: Node + Express + ws + tsx

## Configuración

Igual que la Terminal de Voto: dos archivos en `public/` que el Servidor
Electoral genera antes de la jornada.

### `public/deployment.yml`
Idéntico al de las Terminales de Voto.

### `public/jurado-config.json`
Específico del jurado de **este puesto**:

```json
{
    "puntoId": 1,
    "secreto": "<jwt-bearer-del-punto>",
    "clusterUrl": "http://nodo-votacion.local:8080"
}
```

> ⚠️ El `jurado-config.json` contiene el JWT del punto. NO se versiona en
> producción. El placeholder en este repo es solo para desarrollo.

## Desarrollo local

### Opción A — SPA + sidecar (recomendado)

```bash
npm install
npm run dev:all
```

- **Vite** en `http://localhost:5180` — SPA del jurado.
- **Sidecar** en `http://localhost:8089` (HTTP) + `ws://localhost:8087` (WS).

### Opción B — Solo SPA

```bash
npm run dev
```

Sin sidecar, los eventos `VOTO_EMITIDO` no llegan al SPA y las terminales quedan
marcadas como ocupadas indefinidamente.

### Probar flujo end-to-end (Jurado + Voto en paralelo)

Necesitas **dos terminales abiertas**:

1. **Terminal Voto** (`terminal-votacion`): `npm run dev:all` → Vite 5173, sidecar 8090.
2. **Terminal Jurado** (este repo): `npm run dev:all` → Vite 5180, sidecar 8089.

Abre `http://localhost:5173` (voto) y `http://localhost:5180` (jurado) en pestañas
distintas.

**Flujo de prueba:**

1. En la **Terminal Jurado** verás la lista de votantes y las terminales del punto.
2. Click "Verificar" en un votante → llama a `/votante/{doc}` del Nodo. Sin Nodo
   real, asume "no votado".
3. Click "Autorizar" → aparecen botones por cada terminal libre.
4. Click "Terminal #1" → POST a `http://localhost:8090/handshake` (sidecar Voto).
5. El SPA de la Terminal Voto salta de "espera" a "tarjetón".
6. Marcas y confirmas. La Terminal Voto firma con Ed25519 y trata de enviar al
   Nodo. Sin Nodo real, falla en el envío pero la firma se computa.
7. **Para cerrar el ciclo**, configura `terminal-votacion/public/terminal-config.json`
   con `"parentUrl": "http://localhost:8089"`. Cuando la Terminal Voto notifique al
   Jurado, el sidecar del Jurado recibe `POST /eventos` y libera la terminal.

```bash
# Simular VOTO_EMITIDO directamente al sidecar del jurado:
curl -X POST http://localhost:8089/eventos \
  -H "Content-Type: application/json" \
  -d '{"tipo":"VOTO_EMITIDO","terminalId":1,"votanteId":101}'
```

## Atributos de calidad

- **Control de acceso** — el jurado consulta `votado` antes de autorizar. Si el
  votante ya votó, no se permite re-autorizar.
- **Trazabilidad** — cada autorización genera un `sesionToken` único que la
  Terminal Voto vincula al voto en su evento de auditoría.
- **Tolerancia a fraude** — terminales con `activo=false` se muestran "fuera de
  servicio" y no se pueden seleccionar.
- **Resiliencia** — el sidecar mantiene reconexión automática al WebSocket.

## TODO

- [ ] **Verificación del `sesionToken`** — hoy generamos un token de demo
  trazable. Cuando Augusto defina el JWT formal, firmarlo con la clave del
  punto y la Terminal Voto debe verificarlo.
- [ ] **URL de las Terminales de Voto** — hoy se deriva del id con
  `urlDeTerminal()` (puerto = 8088 + id*2). En producción debe venir del DNS o
  estar declarada en el `deployment.yml`.
- [ ] **Polling de estado del Nodo** — refrescar `votado` periódicamente para
  detectar votos emitidos en otras terminales sin esperar al callback.
- [ ] **Voto asistido (SE-M3-05)** — antes de autorizar, capturar acompañante
  y validar contra `transparency-service`. Reusar `AsistenciaJurado.tsx` que ya
  está en `sello-legitimo-frontend` como referencia.

## Equipo

- Camilo Salinas (yo) — frontend
- Juan Eduardo — frontend
- Coordinación con: Augusto Pedicino (Servidor Electoral), Juan Martín (Nodo)
