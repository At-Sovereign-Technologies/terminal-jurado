// Configuración local específica de la Terminal de Jurado.
// El Servidor Electoral genera esto antes de la jornada y se distribuye
// junto al SPA del jurado en cada máquina física.

export interface JuradoConfig {
    // id del PUNTO al que pertenece este jurado (no del jurado individual).
    // El SPA filtra el deployment.yml para ver solo los datos de su punto.
    puntoId: number;

    // JWT bearer que la terminal del jurado usa al hablar con el Nodo.
    secreto: string;

    // URL del Nodo de Votación Activa (HTTP).
    clusterUrl: string;
}

// Estado en memoria de las sesiones activas que el jurado ha autorizado.
// Se mantiene solo en RAM del SPA; el Nodo es la fuente de verdad final.
export interface SesionAutorizada {
    votanteId: number;
    terminalId: number;
    iniciada: string; // ISO timestamp
    estado: "ACTIVA" | "VOTO_EMITIDO" | "CANCELADA";
}
