// Lee la configuración activa del puesto desde el Nodo (vía sidecar)
// y jurado-config.json al arrancar la terminal del jurado.
//
// El objetivo es evitar depender de deployment.yml "quemado" en el SPA:
// la fuente de verdad del puesto/elegión viene de GET /puesto.

import type { Deployment, DeploymentPunto } from "../types/deployment";
import type { JuradoConfig } from "../types/jurado";

const CONFIG_PATH = "/jurado-config.json";
const SIDECAR_URL =
    (
        import.meta.env as unknown as { VITE_SIDECAR_URL?: string }
    ).VITE_SIDECAR_URL?.trim() || "http://localhost:8089";

interface PuestoApiResponse {
    eleccion?: {
        id?: number;
        nombre?: string;
        tipo_eleccion?: "presidencial" | "legislativa" | "territorial";
        fecha_inicio?: number;
        fecha_fin?: number;
    };
    candidatos?: Array<{
        id?: number;
        nombre?: string;
        documento?: string;
        partido?: string;
        foto_url?: string;
    }>;
    punto?: {
        id?: number;
        nombre?: string;
        latitud?: number;
        longitud?: number;
        jurados?: Array<{
            id?: number;
            nombre?: string;
            documento?: string;
            usuario?: string;
            hash?: string;
        }>;
        terminales?: Array<{
            id?: number;
            votantes?: Array<{
                id?: number;
                nombre?: string;
                documento?: string;
            }>;
        }>;
    };
}

export interface ContextoJurado {
    deployment: Deployment;
    config: JuradoConfig;
    punto: DeploymentPunto;
}

export class ErrorConfiguracion extends Error {
    razon: string;
    constructor(razon: string) {
        super(razon);
        this.razon = razon;
        this.name = "ErrorConfiguracion";
    }
}

async function fetchTexto(path: string): Promise<string> {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) {
        throw new ErrorConfiguracion(
            `No se pudo cargar ${path} (HTTP ${r.status}).`
        );
    }
    return r.text();
}

async function fetchPuestoActivo(): Promise<PuestoApiResponse> {
    const r = await fetch(`${SIDECAR_URL.replace(/\/$/, "")}/puesto`, {
        cache: "no-store",
    });
    if (!r.ok) {
        throw new ErrorConfiguracion(
            `No se pudo cargar /puesto desde sidecar (HTTP ${r.status}).`
        );
    }
    const data = (await r.json().catch(() => null)) as PuestoApiResponse | null;
    if (!data || typeof data !== "object") {
        throw new ErrorConfiguracion("Respuesta inválida en GET /puesto.");
    }
    return data;
}

function mapearPuestoApiADeployment(api: PuestoApiResponse): Deployment {
    const eleccion = api.eleccion;
    const punto = api.punto;

    if (!eleccion || !punto) {
        throw new ErrorConfiguracion(
            "GET /puesto incompleto: faltan eleccion o punto."
        );
    }

    if (!Number.isFinite(eleccion.id) || !eleccion.nombre || !eleccion.tipo_eleccion) {
        throw new ErrorConfiguracion(
            "GET /puesto inválido: eleccion sin id/nombre/tipo_eleccion."
        );
    }
    if (!Number.isFinite(punto.id) || !punto.nombre) {
        throw new ErrorConfiguracion(
            "GET /puesto inválido: punto sin id o nombre."
        );
    }

    return {
        eleccion: {
            id: Number(eleccion.id),
            nombre: String(eleccion.nombre),
            tipoEleccion: eleccion.tipo_eleccion,
            fechaInicio: Number(eleccion.fecha_inicio ?? 0),
            fechaFin: Number(eleccion.fecha_fin ?? 0),
        },
        candidatos: (api.candidatos ?? []).map((c) => ({
            id: Number(c.id ?? 0),
            nombre: String(c.nombre ?? ""),
            documento: String(c.documento ?? ""),
            partido: String(c.partido ?? ""),
            fotoUrl: c.foto_url,
        })),
        puntos: [
            {
                id: Number(punto.id),
                nombre: String(punto.nombre),
                latitud: Number(punto.latitud ?? 0),
                longitud: Number(punto.longitud ?? 0),
                // /puesto no trae activo explícito en el contrato compartido.
                activo: true,
                jurados: (punto.jurados ?? []).map((j) => ({
                    id: Number(j.id ?? 0),
                    nombre: String(j.nombre ?? ""),
                    documento: String(j.documento ?? ""),
                    usuario: String(j.usuario ?? ""),
                    hash: j.hash,
                })),
                terminales: (punto.terminales ?? []).map((t) => ({
                    id: Number(t.id ?? 0),
                    // /puesto no envía secretos ni clave pública.
                    clavePublica: "",
                    activo: true,
                    votantes: (t.votantes ?? []).map((v) => ({
                        id: Number(v.id ?? 0),
                        nombre: String(v.nombre ?? ""),
                        documento: String(v.documento ?? ""),
                    })),
                })),
            },
        ],
    };
}

export async function cargarContextoJurado(): Promise<ContextoJurado> {
    const [configTexto, puestoApi] = await Promise.all([
        fetchTexto(CONFIG_PATH),
        fetchPuestoActivo(),
    ]);

    const deployment = mapearPuestoApiADeployment(puestoApi);

    let config: JuradoConfig;
    try {
        config = JSON.parse(configTexto) as JuradoConfig;
    } catch (e) {
        throw new ErrorConfiguracion(
            `jurado-config.json mal formado: ${e instanceof Error ? e.message : String(e)}`
        );
    }

    if (!config.puntoId || !config.secreto || !config.clusterUrl) {
        throw new ErrorConfiguracion(
            "jurado-config.json incompleto: faltan puntoId, secreto o clusterUrl."
        );
    }
    if (!deployment.puntos?.length) {
        throw new ErrorConfiguracion("GET /puesto no contiene punto válido.");
    }

    const punto = deployment.puntos.find((p) => p.id === config.puntoId);
    if (!punto) {
        throw new ErrorConfiguracion(
            `Punto id=${config.puntoId} no encontrado en la respuesta de GET /puesto.`
        );
    }

    if (!punto.activo) {
        throw new ErrorConfiguracion(
            `Punto id=${punto.id} marcado como inactivo por el Servidor Electoral.`
        );
    }

    return { deployment, config, punto };
}
