# Terminal de Jurado — Sello Legítimo

SPA web para la **Terminal de Jurado** (TJ) de un puesto electoral, dentro
del sub-sistema **Sistema Electoral (SE)**.

Es la consola del jurado en cada puesto. Identifica al votante, verifica
contra el Nodo que no haya votado, selecciona la Terminal de Voto asignada
y le envía un handshake para iniciar la sesión.

## Arquitectura

```
┌─────────────────────┐
│  Servidor Electoral │ ──▶ genera deployment.yml + jurado-config.json
└─────────────────────┘
                       ↓
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
              GET /votante/{doc}     (verificar si ya votó)
              GET /puesto            (polling revocación cada 30s)
              al Nodo de Votación Activa
```

## Stack

- Vite + React 18 + TypeScript
- Tailwind CSS 3
- `axios` para HTTP al Nodo y a las Terminales de Voto
- `yaml` para parsear `deployment.yml`
- Sidecar: Node + Express + ws + tsx

## Configuración

Dos archivos en `public/` generados por el Servidor Electoral antes de la
jornada.

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

Sin sidecar, los eventos `VOTO_EMITIDO` no llegan al SPA y las terminales
quedan marcadas como ocupadas indefinidamente.

### Probar flujo end-to-end (Jurado + Voto en paralelo)

Necesitas **dos terminales abiertas**:

1. **Terminal Voto** (`terminal-votacion`): `npm run dev:all` → Vite 5173, sidecar 8090.
2. **Terminal Jurado** (este repo): `npm run dev:all` → Vite 5180, sidecar 8089.

Abre `http://localhost:5173` (voto) y `http://localhost:5180` (jurado) en
pestañas distintas.

**Flujo de prueba:**

1. En la Terminal Jurado verás la lista de votantes y las terminales del punto.
2. Click "Verificar" en un votante → llama a `/votante/{doc}` del Nodo. Sin
   Nodo real, asume "no votado".
3. Click "Autorizar" → aparece botón con la terminal asignada del votante.
4. Click "→ Terminal #N" → POST a `http://localhost:8090/handshake` (sidecar Voto).
5. El SPA de la Terminal Voto salta de "espera" a "tarjetón".
6. Marcas, confirmas. La Terminal Voto firma con Ed25519 y envía al Nodo.
   Sin Nodo real falla en el envío pero la firma se computa.
7. Para cerrar el ciclo, configura
   `terminal-votacion/public/terminal-config.json` con
   `"parentUrl": "http://localhost:8089"`. Cuando la Terminal Voto notifique
   al Jurado, el sidecar del Jurado recibe `POST /eventos` y libera la
   terminal.

```bash
# Simular VOTO_EMITIDO directamente al sidecar del jurado:
curl -X POST http://localhost:8089/eventos \
  -H "Content-Type: application/json" \
  -d '{"tipo":"VOTO_EMITIDO","terminalId":1,"votanteId":101}'
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

**Control de fraude**: el sistema rechaza si un mismo acompañante no
familiar ya asistió a otro votante en la jornada (CA #3 de SE-M3-05). Los
familiares no están sujetos a ese límite.

## Revocación en caliente

Cada 30 segundos el SPA llama a `GET /puesto` del Nodo. Dos efectos:

1. Si el Servidor Electoral marcó este punto entero como inactivo, la mesa
   se bloquea con "Mesa del Jurado revocada".
2. Si cambia el flag `activo` de alguna terminal de voto del punto, su
   tarjeta en la columna derecha se actualiza (LIBRE ↔ FUERA DE SERVICIO)
   sin reinicio.

Caídas temporales del Nodo no disparan revocación: solo se loguean.

## Atributos de calidad

- **Control de acceso** — el jurado consulta `votado` antes de autorizar.
  Si el votante ya votó, no se permite re-autorizar.
- **Trazabilidad** — cada autorización genera un `sesionToken` único que la
  Terminal de Voto vincula al voto en su evento de auditoría.
- **Tolerancia a fraude** — terminales con `activo=false` aparecen "fuera de
  servicio" y no se pueden seleccionar. Punto revocado bloquea toda la mesa.
- **Privacidad del voto asistido** — los documentos del acompañante nunca
  se persisten en claro; solo viaja el SHA-256 al registro de auditoría.
- **Resiliencia** — sidecar con reconexión automática al WebSocket.

## Pendientes

- **Verificación del `sesionToken`.** Hoy generamos un token de demo
  trazable. Cuando el formato del JWT del jurado quede definido, firmarlo
  con la clave del punto y la Terminal Voto debe verificarlo.
- **URL de las Terminales de Voto.** Hoy se deriva del id con
  `urlDeTerminal()` (puerto = 8088 + id*2). En producción debe venir del
  DNS interno del puesto o estar declarada en el `deployment.yml`.
- **Endpoint real del transparency-service para asistencia.** Hoy
  `registrarAsistencia` valida localmente en memoria. Cuando exista el
  endpoint REST consultable desde la terminal, el adaptador hace POST con
  el hash del acompañante.
- **Pruebas unitarias.** Sin tests todavía. Pendiente cobertura de:
  - `registrarAsistencia` (límite no-familiar, exención de familiares).
  - Hook de polling con timers fake.
  - Sidecar (curl + recepción WebSocket).
