import { useState } from "react";
import type { FormEvent } from "react";
import { Accessibility, AlertCircle, Loader2, X } from "lucide-react";
import type {
    DatosAsistencia,
    TipoAsistencia,
} from "../types/asistencia";

const TIPOS: { valor: TipoAsistencia; etiqueta: string }[] = [
    { valor: "Discapacidad", etiqueta: "Discapacidad" },
    { valor: "EdadAvanzada", etiqueta: "Edad avanzada" },
    { valor: "Analfabetismo", etiqueta: "Analfabetismo" },
    { valor: "Otra", etiqueta: "Otra" },
];

interface Props {
    documentoVotante: string;
    onCerrar: () => void;
    onConfirmar: (datos: DatosAsistencia) => Promise<void>;
}

// Diálogo del jurado para capturar los datos del acompañante (SE-M3-05).
// El hash del documento se calcula al confirmar, no aquí.
export default function DialogoVotoAsistido({
    documentoVotante,
    onCerrar,
    onConfirmar,
}: Props) {
    const [documentoAcompanante, setDocumentoAcompanante] = useState("");
    const [esFamiliar, setEsFamiliar] = useState(false);
    const [tipo, setTipo] = useState<TipoAsistencia>("Discapacidad");
    const [error, setError] = useState<string | null>(null);
    const [enviando, setEnviando] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);

        const doc = documentoAcompanante.trim();
        if (doc.length < 5) {
            setError("El documento del acompañante debe tener al menos 5 caracteres.");
            return;
        }
        if (doc === documentoVotante) {
            setError(
                "El votante y el acompañante no pueden tener el mismo documento."
            );
            return;
        }

        setEnviando(true);
        try {
            await onConfirmar({
                documentoAcompanante: doc,
                esFamiliar,
                tipoAsistencia: tipo,
            });
        } finally {
            setEnviando(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
        >
            <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
                <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                            <Accessibility size={20} className="text-red-500" />
                        </div>
                        <div>
                            <h3 className="font-extrabold text-gray-900">
                                Voto asistido
                            </h3>
                            <p className="text-xs text-gray-500">
                                SE-M3-05 · capture al acompañante
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onCerrar}
                        aria-label="Cerrar"
                        disabled={enviando}
                        className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                    >
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={submit} className="space-y-4">
                    <div>
                        <label className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
                            Documento del acompañante
                        </label>
                        <input
                            type="text"
                            value={documentoAcompanante}
                            onChange={(e) =>
                                setDocumentoAcompanante(e.target.value)
                            }
                            placeholder="2020202020"
                            inputMode="numeric"
                            autoComplete="off"
                            className="w-full mt-2 border rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-400"
                        />
                    </div>

                    <label className="flex items-start gap-3 border rounded-xl p-3 cursor-pointer hover:bg-gray-50">
                        <input
                            type="checkbox"
                            checked={esFamiliar}
                            onChange={(e) => setEsFamiliar(e.target.checked)}
                            className="mt-1"
                        />
                        <div>
                            <p className="font-semibold text-sm">
                                Es familiar del votante
                            </p>
                            <p className="text-[11px] text-gray-500 leading-snug">
                                Familiares no están sujetos al límite legal de
                                "1 acompañante no-familiar por jornada".
                            </p>
                        </div>
                    </label>

                    <div>
                        <label className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-2 block">
                            Tipo de asistencia
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {TIPOS.map((t) => (
                                <button
                                    type="button"
                                    key={t.valor}
                                    onClick={() => setTipo(t.valor)}
                                    className={`text-sm font-bold border rounded-lg py-2 ${
                                        tipo === t.valor
                                            ? "border-red-500 bg-red-50 text-red-600"
                                            : "border-gray-200 text-gray-700 hover:bg-gray-50"
                                    }`}
                                >
                                    {t.etiqueta}
                                </button>
                            ))}
                        </div>
                    </div>

                    {error && (
                        <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 flex items-start gap-2 text-xs text-red-700">
                            <AlertCircle size={14} className="shrink-0 mt-0.5" />
                            {error}
                        </div>
                    )}

                    <div className="flex flex-col sm:flex-row gap-2">
                        <button
                            type="button"
                            onClick={onCerrar}
                            disabled={enviando}
                            className="flex-1 border rounded-xl py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            disabled={enviando}
                            className="flex-1 flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-bold uppercase tracking-wide"
                        >
                            {enviando ? (
                                <>
                                    <Loader2
                                        size={14}
                                        className="animate-spin"
                                    />
                                    Registrando…
                                </>
                            ) : (
                                "Registrar y autorizar"
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
