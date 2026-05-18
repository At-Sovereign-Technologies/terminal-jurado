# Terminal de Jurado — Sello Legítimo

SPA web + sidecar Node para la **Terminal de Jurado** (TJ) de un puesto
electoral, dentro del sub-sistema **Sistema Electoral (SE)**.

Es la consola del jurado en cada puesto. A diferencia de la Terminal Voto
(que es solo cliente), la Terminal Jurado **escucha conexiones de las
Terminales Voto del puesto y las delega al Nodo de Votación Activa**.

## Arquitectura

```
        ┌─────────────────────┐
        │  Servidor Electoral │ ──▶ deployment.yml + jurado-config.json
        └─────────────────────┘
                              ↓
        ┌──────────────────────────────────────────────────┐
        │  Máquina del Jurado                              │
        │                                                  │
        │  ┌──────────────────┐   ┌────────────────────┐   │
        │  │  SPA (browser)   │←──│  Sidecar Node      │   │
        │  │  - lista votantes│   │  - WS :8090 (Voto) │   │
        │  │  - autoriza      │   │  - WS :8087 (SPA)  │   │
        │  │  - voto asistido │   │  - HTTP :8089      │   │
        │  └──────────────────┘   │  - cola.json       │   │
        │                          │  - retry al Nodo   │   │
        │                          └─────────┬──────────┘   │
        └─────────────────────────────────────│─────────────┘
                                              │ POST /votar (HTTP)
                                              ↓
                                ┌──────────────────────────┐
                                │ Nodo de Votación Activa  │
                                └──────────────────────────┘

                          ↑ WebSocket persistente
                          │ HANDSHAKE / VOTO
        ┌─────────────────────────┐
        │  Terminales de Voto     │
        │  (clientes WS puros)    │
        └─────────────────────────┘
```

### Por qué hay sidecar Node aquí pero no en Voto

El Jurado **escucha conexiones de las Terminales Voto del puesto**. Como un
browser no puede recibir conexiones entrantes, el sidecar Node hace ese rol:

- **Acepta WebSockets** de las Terminales Voto (puerto 8090).
- **Autentica cada terminal** en el HELLO contra `deployment.yml` +
  `jurado-config.json` (id + secreto compartido).
- **Verifica la firma Ed25519** de cada voto con la clave pública de la
  terminal antes de encolar o reenviar al Nodo.
- **Reenvía votos** al Nodo de Votación Activa por HTTP.
- **Guarda en cola local** (`sidecar/cola.json`) cuando el Nodo está caído.
- **Reintenta cada 10 s** hasta drenar la cola.
- **Recarga `deployment.yml` cada 30 s** para detectar revocaciones en
  caliente (terminales o punto entero); cierra los WebSockets de las
  terminales revocadas.
- **Proxea al Nodo** las consultas del SPA (p. ej. `GET /votante/:doc`)
  para que el SPA no tenga acceso directo al Nodo.
- **Notifica al SPA del Jurado** por otro WebSocket (puerto 8087) de eventos
  en vivo: voto emitido, cola pendiente, terminal revocada, punto revocado.

La Terminal Voto, en cambio, es 100% cliente: solo abre WebSockets, no
acepta nada. Por eso esa no necesita sidecar.

## Stack

- Vite + React 18 + TypeScript (SPA)
- Tailwind CSS 3 (estilos)
- `axios` para HTTP del SPA al sidecar
- `yaml` para parsear `deployment.yml`
- Sidecar: Node + Express + ws + tsx, sin librerías de cola (JSON simple)

## Configuración

Dos archivos en `public/` generados por el Servidor Electoral.

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

> `clusterUrl` lo lee el SIDECAR vía variable de entorno `NODO_URL`. El SPA
> no se conecta directo al Nodo; solo le habla al sidecar.

## Desarrollo local

```bash
npm install
npm run dev:all
```

Eso levanta:

- **Vite** en `http://localhost:5180` — SPA del jurado.
- **Sidecar** en `:8089` (HTTP), `:8090` (WS Voto), `:8087` (WS Jurado).

Por defecto el sidecar intenta hablar con el Nodo en `http://localhost:8080`.
Como el Nodo no existe todavía, todos los votos terminarán en `cola.json` y
el sidecar reintentará cada 10 s.

### Probar flujo end-to-end (Jurado + Voto en paralelo)

Necesitas **dos terminales abiertas**:

1. **Terminal Voto** (`terminal-votacion`, repo aparte): `npm run dev` → Vite 5173.
2. **Terminal Jurado** (este repo): `npm run dev:all`.

Abre `http://localhost:5173` (voto) y `http://localhost:5180` (jurado) en
pestañas distintas.

**Flujo de prueba:**

1. La Terminal Voto se conecta al sidecar (verás en la consola del sidecar
   `[jurado-sidecar] HELLO de Terminal Voto #N`).
2. En el SPA del Jurado, click "Verificar" en un votante → mock asume "no
   votado" (no hay Nodo).
3. Click "Autorizar" → click sobre la terminal asignada → el SPA hace POST
   al sidecar (`localhost:8089/handshake`) → el sidecar empuja el HANDSHAKE
   por WebSocket a la Terminal Voto.
4. La Terminal Voto pasa a tarjetón inmediatamente.
5. Marcas y confirmas. La Terminal Voto firma con Ed25519 y manda VOTO por
   WS al sidecar.
6. El sidecar reenvía al Nodo. Como no hay Nodo, lo encola en `cola.json` y
   responde a la Voto con número de confirmación provisional (`VC-OFF-...`).
7. La Voto muestra el comprobante; el SPA del Jurado libera la terminal
   automáticamente.

### Inspeccionar la cola offline

```bash
cat sidecar/cola.json
```

Verás cada voto pendiente con su `intentos` (cuántas veces el sidecar trató
de reenviarlo al Nodo). Cuando levantes un Nodo real, el sidecar drenará la
cola sin intervención manual.

### Atajos curl para tests manuales

```bash
# Liberar manualmente una terminal (simular voto emitido sin pasar por Voto):
curl -X POST http://localhost:8089/eventos \
  -H "Content-Type: application/json" \
  -d '{"tipo":"VOTO_EMITIDO","terminalId":1,"votanteId":101}'

# Estado del sidecar:
curl http://localhost:8089/health
```

## Voto Asistido (SE-M3-05)

Cada votante tiene un botón **"Asistido"** además del de "Autorizar". El
flujo:

1. Click "Asistido" → click sobre la terminal asignada del votante.
2. Se abre un diálogo modal que pide:
   - Documento del acompañante.
   - Si es familiar del votante (checkbox).
   - Tipo de asistencia (Discapacidad, Edad avanzada, Analfabetismo, Otra).
3. Al confirmar, el SPA calcula SHA-256 del documento (nunca viaja en
   claro), valida el límite legal y, si pasa, envía el handshake con el
   hash del acompañante anexado al `sesionToken`.

**Control de fraude**: rechaza si un mismo acompañante no familiar ya
asistió a otro votante en la jornada (CA #3 de SE-M3-05). Los familiares
no están sujetos a ese límite.

## Atributos de calidad

- **Control de acceso** — el jurado consulta `votado` antes de autorizar.
  Si el votante ya votó, no se permite re-autorizar. El sidecar autentica
  cada Terminal Voto en el HELLO (id + secreto contra `deployment.yml`).
- **Integridad** — el sidecar verifica la firma Ed25519 de cada voto con
  la clave pública declarada en `deployment.yml` antes de encolar o
  reenviar al Nodo. Además valida que el campo `terminal` del payload
  coincida con la terminal autenticada (anti-spoofing).
- **Trazabilidad** — cada autorización genera un `sesionToken` único; cada
  voto recibido por el sidecar se loguea con `terminal` y `votante`; la
  cola guarda intentos de retry.
- **Revocación en caliente** — el sidecar recarga `deployment.yml` cada
  30 s. Si el Servidor Electoral marca una terminal o el punto entero
  como `activo: false`, el sidecar cierra los WebSockets afectados y
  notifica al SPA del jurado (`TERMINAL_REVOCADA` / `PUNTO_REVOCADO`).
- **Resiliencia (offline-first)** — si el Nodo está caído, los votos se
  encolan en disco (`sidecar/cola.json`) y el sidecar reintenta cada 10 s
  hasta drenarlos. La jornada puede continuar sin Nodo. El SPA muestra
  un badge ámbar en el header con la cuenta en vivo de votos en cola.
- **Privacidad del voto asistido** — los documentos del acompañante nunca
  se persisten en claro; solo viaja el SHA-256 en el sesionToken.

## Pruebas

```bash
npm test
```

Vitest corre los tests en `src/api/asistencia.api.test.ts`:

- Acepta un acompañante no-familiar la primera vez en la jornada.
- Rechaza el **mismo** acompañante no-familiar la segunda vez (CA #3 de
  SE-M3-05).
- Permite al mismo familiar acompañar a múltiples votantes (sin límite).
- Normaliza espacios al comparar documentos: `"100000004"` y
  `"  100000004  "` se consideran el mismo acompañante.

## Pendientes

- **Verificación del `sesionToken`.** Hoy generamos un token de demo
  trazable. Cuando el formato del JWT del jurado quede definido, firmarlo
  con la clave del punto y la Terminal Voto debe verificarlo.
- **Endpoint real del transparency-service para asistencia.** Hoy
  `registrarAsistencia` valida localmente en memoria.
- **Más cobertura de tests del sidecar.** Falta cubrir: drenaje de la
  cola offline contra un Nodo mock, multiplexor HELLO/VOTO/HANDSHAKE por
  WS, y el flujo de revocación en caliente end-to-end.
