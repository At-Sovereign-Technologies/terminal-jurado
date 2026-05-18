// Espejo del deployment.yml generado por el Servidor Electoral antes de la jornada.
// El archivo se distribuye junto al SPA y contiene TODA la configuración necesaria
// para que la terminal opere sin tener que pedir nada al arranque.
//
// Cada terminal lee este archivo + su propio terminal-config.json y filtra
// la información que le corresponde por id.

export interface DeploymentEleccion {
    id: number;
    nombre: string;
    tipoEleccion: "presidencial" | "legislativa" | "territorial";
    fechaInicio: number; // unix timestamp segundos
    fechaFin: number;
}

export interface DeploymentCandidato {
    id: number;
    nombre: string;
    documento: string;
    partido: string;
    fotoUrl?: string;
}

export interface DeploymentJurado {
    id: number;
    nombre: string;
    documento: string;
    usuario: string;
    // hash de Argon2 — no se usa en la terminal de votación, solo en la del jurado.
    hash?: string;
}

export interface DeploymentVotante {
    id: number;
    nombre: string;
    documento: string;
}

export interface DeploymentTerminal {
    id: number;
    // JWT bearer que la terminal usa al hablar con el Nodo.
    // Solo el Servidor Electoral tiene la facultad de revocarlo.
    secreto?: string;
    clavePublica: string;
    activo: boolean;
    votantes: DeploymentVotante[];
}

export interface DeploymentPunto {
    id: number;
    nombre: string;
    latitud: number;
    longitud: number;
    activo: boolean;
    secreto?: string;
    jurados: DeploymentJurado[];
    terminales: DeploymentTerminal[];
}

export interface Deployment {
    eleccion: DeploymentEleccion;
    candidatos: DeploymentCandidato[];
    puntos: DeploymentPunto[];
}

// Config local de la propia terminal (deploy individual por máquina).
export interface TerminalConfig {
    id: number;
    secreto: string; // JWT bearer
    clavePrivada: string; // Ed25519, hex o base64. Nunca se serializa hacia afuera.
    clusterUrl: string; // URL del Nodo de Votación Activa
    parentUrl: string; // URL de la Terminal de Jurado del mismo punto
}
