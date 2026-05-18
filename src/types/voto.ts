// Contrato con POST /votar del Nodo de Votación Activa.
// La estructura `voto` es lo que viaja en claro y lo que se firma.
// La firma Ed25519 se calcula sobre la serialización canónica de `voto`.

export interface VotoPayload {
    terminal: number;
    votante: number;
    candidato: number;
}

export interface VotoFirmado {
    voto: VotoPayload;
    firma: string; // Ed25519 en hex
}

export interface RespuestaVotanteIdentidad {
    votado: boolean;
}

// Lo que la Terminal de Jurado envía al endpoint local /handshake de
// la Terminal de Votación cuando autoriza una sesión.
//
// `sesionToken` es un JWT firmado por el secreto del Jurado que la
// Terminal de Voto puede verificar antes de mostrar el tarjetón.
export interface HandshakePayload {
    votanteId: number;
    sesionToken: string;
}

// Lo que las Terminales de Voto envían a la Terminal de Jurado por
// `parent_url` cuando el votante termina su interacción.
export interface EventoTerminalVoto {
    tipo: "VOTO_EMITIDO" | "SESION_CANCELADA";
    terminalId: number;
    votanteId?: number;
}
