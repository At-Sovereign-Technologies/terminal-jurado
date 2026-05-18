import { Loader2, AlertTriangle } from "lucide-react";
import { JuradoProvider, useJuradoContext } from "./config/JuradoContext";
import JuradoApp from "./pages/JuradoApp";

function ContenidoSegunFase() {
    const estado = useJuradoContext();

    if (estado.fase === "cargando") {
        return (
            <main className="min-h-screen flex flex-col items-center justify-center bg-white">
                <Loader2 size={42} className="text-gray-400 animate-spin" />
                <p className="text-gray-500 mt-4 text-sm">
                    Cargando configuración de la terminal del jurado...
                </p>
            </main>
        );
    }

    if (estado.fase === "error") {
        return (
            <main className="min-h-screen flex flex-col items-center justify-center bg-white text-center px-10">
                <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center mb-5">
                    <AlertTriangle size={36} className="text-red-600" />
                </div>
                <h1 className="text-2xl font-extrabold text-gray-900">
                    Mesa del jurado no operativa
                </h1>
                <p className="text-base text-gray-600 mt-3 max-w-xl">
                    {estado.mensaje}
                </p>
                <p className="text-xs text-gray-400 mt-6">
                    Contacte al operador del puesto para regenerar la
                    configuración desde el Servidor Electoral.
                </p>
            </main>
        );
    }

    return <JuradoApp />;
}

export default function App() {
    return (
        <JuradoProvider>
            <ContenidoSegunFase />
        </JuradoProvider>
    );
}
