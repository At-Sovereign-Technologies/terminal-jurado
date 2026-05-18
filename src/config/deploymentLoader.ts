// Lee el deployment.yml y jurado-config.json al arrancar la terminal del jurado.
// El Servidor Electoral genera ambos archivos antes de la jornada y se
// distribuyen físicamente a la máquina del jurado.
//
// Diferencia con la Terminal de Votación: aquí filtramos por PUNTO, no por
// terminal individual. El jurado necesita ver todas las terminales y todos
// los votantes de su punto.

import { parse as parseYaml } from "yaml";
import type { Deployment, DeploymentPunto } from "../types/deployment";
import type { JuradoConfig } from "../types/jurado";

const DEPLOYMENT_PATH = "/deployment.yml";
const CONFIG_PATH = "/jurado-config.json";

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

export async function cargarContextoJurado(): Promise<ContextoJurado> {
    const [yamlTexto, configTexto] = await Promise.all([
        fetchTexto(DEPLOYMENT_PATH),
        fetchTexto(CONFIG_PATH),
    ]);

    let deployment: Deployment;
    try {
        deployment = parseYaml(yamlTexto) as Deployment;
    } catch (e) {
        throw new ErrorConfiguracion(
            `deployment.yml mal formado: ${e instanceof Error ? e.message : String(e)}`
        );
    }

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
        throw new ErrorConfiguracion("deployment.yml no contiene puntos.");
    }

    const punto = deployment.puntos.find((p) => p.id === config.puntoId);
    if (!punto) {
        throw new ErrorConfiguracion(
            `Punto id=${config.puntoId} no encontrado en deployment.yml.`
        );
    }

    if (!punto.activo) {
        throw new ErrorConfiguracion(
            `Punto id=${punto.id} marcado como inactivo por el Servidor Electoral.`
        );
    }

    return { deployment, config, punto };
}
