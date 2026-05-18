import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cargarContextoJurado, ErrorConfiguracion } from "./deploymentLoader";
import type { ContextoJurado } from "./deploymentLoader";

type Estado =
    | { fase: "cargando" }
    | { fase: "listo"; ctx: ContextoJurado }
    | { fase: "error"; mensaje: string };

const JuradoCtx = createContext<Estado>({ fase: "cargando" });

export function JuradoProvider({ children }: { children: ReactNode }) {
    const [estado, setEstado] = useState<Estado>({ fase: "cargando" });

    useEffect(() => {
        cargarContextoJurado()
            .then((ctx) => setEstado({ fase: "listo", ctx }))
            .catch((e) => {
                const mensaje =
                    e instanceof ErrorConfiguracion
                        ? e.razon
                        : e instanceof Error
                          ? e.message
                          : "Error desconocido al cargar configuración.";
                setEstado({ fase: "error", mensaje });
            });
    }, []);

    return <JuradoCtx.Provider value={estado}>{children}</JuradoCtx.Provider>;
}

export function useJuradoContext(): Estado {
    return useContext(JuradoCtx);
}

export function useContextoListo(): ContextoJurado {
    const e = useContext(JuradoCtx);
    if (e.fase !== "listo") {
        throw new Error(
            "useContextoListo llamado antes de que la terminal del jurado estuviera lista."
        );
    }
    return e.ctx;
}
