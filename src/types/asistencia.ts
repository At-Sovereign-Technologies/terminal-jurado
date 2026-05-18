// SE-M3-05 — Tipos de voto asistido en la terminal del jurado.
//
// El jurado captura los datos del acompañante antes de autorizar el handshake.
// Los documentos NUNCA se envían en claro: solo el SHA-256 va al
// transparency-service y al handshake (en el evento de auditoría).

export type TipoAsistencia =
    | "Discapacidad"
    | "EdadAvanzada"
    | "Analfabetismo"
    | "Otra";

export interface DatosAsistencia {
    documentoAcompanante: string;
    esFamiliar: boolean;
    tipoAsistencia: TipoAsistencia;
}

// Resultado del registro de asistencia. Si excede el límite legal,
// el flujo se bloquea (CA #4 de US-SE-M3-05).
export interface ResultadoRegistroAsistencia {
    ok: boolean;
    hashAcompanante?: string;
    motivoRechazo?: string;
}
