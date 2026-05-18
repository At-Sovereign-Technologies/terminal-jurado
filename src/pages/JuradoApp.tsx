import { useEffect, useMemo, useState } from "react";
import {
    Accessibility,
    AlertCircle,
    CheckCircle2,
    Loader2,
    Search,
    ShieldCheck,
    UserCheck,
    UserX,
} from "lucide-react";
import { useContextoListo } from "../config/JuradoContext";
import { crearNodoClient } from "../api/nodo.api";
import { enviarHandshake } from "../api/terminalVoto.api";
import { subscribirseAEventosTerminal } from "../api/sidecarClient";
import { registrarAsistencia } from "../api/asistencia.api";
import { usePollingRevocacion } from "../config/usePollingRevocacion";
import type {
    DeploymentVotante,
    DeploymentTerminal,
} from "../types/deployment";
import type { DatosAsistencia } from "../types/asistencia";
import DialogoVotoAsistido from "./DialogoVotoAsistido";

type EstadoTerminal = "LIBRE" | "OCUPADA" | "FUERA_DE_SERVICIO";

interface VistaTerminal {
    terminal: DeploymentTerminal;
    estado: EstadoTerminal;
    votanteActualId?: number;
}

export default function JuradoApp() {
    const { config, punto } = useContextoListo();
    const nodo = useMemo(
        () =>
            crearNodoClient({
                clusterUrl: config.clusterUrl,
                secreto: config.secreto,
            }),
        [config]
    );

    // Aggregamos todos los votantes del punto + a qué terminal está asignado
    // cada uno. El jurado solo puede enviar al votante a SU terminal asignada
    // (las terminales no comparten su lista de votantes asignados).
    const todosVotantes = useMemo<
        Array<{ votante: DeploymentVotante; terminalAsignadaId: number }>
    >(() => {
        const flat: Array<{
            votante: DeploymentVotante;
            terminalAsignadaId: number;
        }> = [];
        for (const t of punto.terminales) {
            for (const v of t.votantes) {
                flat.push({ votante: v, terminalAsignadaId: t.id });
            }
        }
        return flat;
    }, [punto]);

    const [busqueda, setBusqueda] = useState("");
    const [votadoMap, setVotadoMap] = useState<Record<string, boolean>>({});
    const [verificando, setVerificando] = useState<string | null>(null);
    const [mensaje, setMensaje] = useState<{
        tipo: "ok" | "error";
        texto: string;
    } | null>(null);

    // SE-M3-05 — diálogo de voto asistido. Cuando hay valor, se muestra el
    // modal para capturar al acompañante antes de autorizar la sesión.
    const [sesionAsistida, setSesionAsistida] = useState<
        | { votante: DeploymentVotante; terminalId: number }
        | null
    >(null);

    // Polling: si el Servidor Electoral revoca el punto entero en caliente,
    // bloqueamos la mesa del jurado. Si revoca terminales individuales, las
    // marcamos como FUERA_DE_SERVICIO sin interrumpir al jurado.
    const [puntoRevocado, setPuntoRevocado] = useState<string | null>(null);

    usePollingRevocacion({
        clusterUrl: config.clusterUrl,
        secreto: config.secreto,
        puntoId: punto.id,
        onPuntoRevocado: (motivo) => setPuntoRevocado(motivo),
        onTerminalesActualizadas: (terminalesRemotas) => {
            setVistas((prev) =>
                prev.map((v) => {
                    const remota = terminalesRemotas.find(
                        (x) => x.id === v.terminal.id
                    );
                    if (!remota) return v;
                    // Si el Servidor Electoral revoca esta terminal, la
                    // forzamos a FUERA_DE_SERVICIO. Si la reactiva y ya estaba
                    // libre, no hacemos nada (no degradamos OCUPADA → LIBRE
                    // sin que llegue el evento real del sidecar).
                    if (!remota.activo) {
                        return v.estado === "FUERA_DE_SERVICIO"
                            ? v
                            : { ...v, estado: "FUERA_DE_SERVICIO" };
                    }
                    if (v.estado === "FUERA_DE_SERVICIO") {
                        return { ...v, estado: "LIBRE" };
                    }
                    return v;
                })
            );
        },
    });

    // Estado de cada terminal del punto: libre / ocupada / fuera de servicio.
    // Se inicializa según `activo`; los eventos del sidecar (VOTO_EMITIDO,
    // SESION_CANCELADA) la liberan al final de cada sesión.
    const [vistas, setVistas] = useState<VistaTerminal[]>(() =>
        punto.terminales.map((t) => ({
            terminal: t,
            estado: t.activo ? "LIBRE" : "FUERA_DE_SERVICIO",
        }))
    );

    useEffect(() => {
        const sub = subscribirseAEventosTerminal((ev) => {
            setVistas((prev) =>
                prev.map((v) =>
                    v.terminal.id === ev.terminalId
                        ? { ...v, estado: "LIBRE", votanteActualId: undefined }
                        : v
                )
            );
            setMensaje({
                tipo: "ok",
                texto: `Terminal ${ev.terminalId}: ${ev.tipo === "VOTO_EMITIDO" ? "voto emitido" : "sesión cancelada"}.`,
            });
        });
        return () => sub.cerrar();
    }, []);

    const votantesFiltrados = useMemo(() => {
        const q = busqueda.trim().toLowerCase();
        if (!q) return todosVotantes;
        return todosVotantes.filter(
            ({ votante: v }) =>
                v.documento.toLowerCase().includes(q) ||
                v.nombre.toLowerCase().includes(q)
        );
    }, [busqueda, todosVotantes]);

    const verificarVotante = async (documento: string) => {
        if (votadoMap[documento] !== undefined) return;
        setVerificando(documento);
        try {
            const r = await nodo.consultarVotante(documento);
            setVotadoMap((m) => ({ ...m, [documento]: r.votado }));
        } catch {
            // Si el Nodo no responde, asumimos "no votado" (decisión cuestionable
            // pero hace que la demo no se bloquee).
            setVotadoMap((m) => ({ ...m, [documento]: false }));
        } finally {
            setVerificando(null);
        }
    };

    const autorizarSesion = async (
        votante: DeploymentVotante,
        terminalId: number,
        hashAsistencia?: string
    ) => {
        setMensaje(null);
        // sesionToken será un JWT firmado por el jurado cuando Augusto defina el
        // formato. Por ahora generamos un token de demo trazable.
        // Cuando hay voto asistido, anexamos el hash del acompañante para que
        // el evento de auditoría en SR-M6 quede vinculado a la sesión.
        const sufijoAsistido = hashAsistencia
            ? `-asist${hashAsistencia.slice(0, 8)}`
            : "";
        const sesionToken = `jurado-demo-${Date.now()}-v${votante.id}-t${terminalId}${sufijoAsistido}`;

        const r = await enviarHandshake(terminalId, {
            votanteId: votante.id,
            sesionToken,
        });

        if (!r.ok) {
            setMensaje({
                tipo: "error",
                texto: `No se pudo enviar el handshake a la terminal ${terminalId}: ${r.error ?? "error desconocido"}.`,
            });
            return false;
        }

        setVistas((prev) =>
            prev.map((v) =>
                v.terminal.id === terminalId
                    ? { ...v, estado: "OCUPADA", votanteActualId: votante.id }
                    : v
            )
        );
        setVotadoMap((m) => ({ ...m, [votante.documento]: true }));
        setMensaje({
            tipo: "ok",
            texto: hashAsistencia
                ? `Sesión asistida autorizada para ${votante.nombre} en la terminal ${terminalId}.`
                : `Sesión autorizada para ${votante.nombre} en la terminal ${terminalId}.`,
        });
        return true;
    };

    // SE-M3-05: registra al acompañante en SR-M6 (mock) y luego dispara el
    // handshake. Si el acompañante excede el límite legal, NO se autoriza.
    const confirmarVotoAsistido = async (
        datos: DatosAsistencia
    ): Promise<void> => {
        if (!sesionAsistida) return;
        const { votante, terminalId } = sesionAsistida;

        const r = await registrarAsistencia(datos);
        if (!r.ok) {
            setMensaje({
                tipo: "error",
                texto: r.motivoRechazo ?? "No se pudo registrar la asistencia.",
            });
            setSesionAsistida(null);
            return;
        }

        const okHandshake = await autorizarSesion(
            votante,
            terminalId,
            r.hashAcompanante
        );
        if (okHandshake) {
            setSesionAsistida(null);
        }
    };

    if (puntoRevocado) {
        return (
            <main className="min-h-screen flex flex-col items-center justify-center bg-white text-center px-10">
                <div className="w-24 h-24 rounded-full bg-red-100 flex items-center justify-center mb-6">
                    <AlertCircle size={42} className="text-red-600" />
                </div>
                <h1 className="text-3xl font-extrabold text-gray-900">
                    Mesa del Jurado revocada
                </h1>
                <p className="text-base text-gray-600 mt-3 max-w-xl">
                    {puntoRevocado}
                </p>
                <p className="text-xs text-gray-400 mt-6 max-w-md">
                    No se pueden autorizar nuevas sesiones. Contacte al
                    operador del puesto para restablecer el servicio desde el
                    Servidor Electoral.
                </p>
            </main>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col">
            <header className="bg-white border-b px-8 py-4 flex items-center justify-between sticky top-0 z-30">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-red-500 rounded-lg flex items-center justify-center">
                        <ShieldCheck size={20} className="text-white" />
                    </div>
                    <div>
                        <h1 className="font-extrabold text-base leading-none">
                            Mesa del Jurado
                        </h1>
                        <p className="text-[11px] text-gray-500 uppercase tracking-wider">
                            {punto.nombre}
                        </p>
                    </div>
                </div>
                <div className="text-right">
                    <p className="text-xs text-gray-400 uppercase tracking-wider">
                        Punto
                    </p>
                    <p className="text-sm font-mono">#{punto.id}</p>
                </div>
            </header>

            <main className="flex-1 px-8 py-8 max-w-6xl mx-auto w-full">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Columna 1-2: lista de votantes */}
                    <section className="lg:col-span-2 bg-white border rounded-2xl p-6 shadow-sm">
                        <div className="flex items-center gap-2 mb-4">
                            <Search size={16} className="text-gray-400" />
                            <input
                                value={busqueda}
                                onChange={(e) => setBusqueda(e.target.value)}
                                placeholder="Buscar por documento o nombre…"
                                className="flex-1 border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
                            />
                        </div>

                        <p className="text-xs uppercase tracking-wider text-gray-400 font-semibold mb-3">
                            Votantes del puesto · {votantesFiltrados.length}
                        </p>

                        <ul className="divide-y border rounded-xl overflow-hidden">
                            {votantesFiltrados.map(
                                ({ votante: v, terminalAsignadaId }) => {
                                    // El votante solo puede ir a su terminal
                                    // asignada (el deployment.yml define qué
                                    // terminal contiene a cada votante).
                                    const terminalAsignada = vistas.find(
                                        (x) => x.terminal.id === terminalAsignadaId
                                    );
                                    const terminalDisponible =
                                        terminalAsignada?.estado === "LIBRE"
                                            ? [terminalAsignada]
                                            : [];
                                    return (
                                        <FilaVotante
                                            key={v.id}
                                            votante={v}
                                            terminalAsignadaId={terminalAsignadaId}
                                            terminalAsignadaEstado={
                                                terminalAsignada?.estado ??
                                                "FUERA_DE_SERVICIO"
                                            }
                                            votado={votadoMap[v.documento]}
                                            verificando={
                                                verificando === v.documento
                                            }
                                            onVerificar={() =>
                                                verificarVotante(v.documento)
                                            }
                                            terminalesDisponibles={
                                                terminalDisponible
                                            }
                                            onAutorizar={(terminalId) =>
                                                autorizarSesion(v, terminalId)
                                            }
                                            onAutorizarAsistido={(terminalId) =>
                                                setSesionAsistida({
                                                    votante: v,
                                                    terminalId,
                                                })
                                            }
                                        />
                                    );
                                }
                            )}
                            {votantesFiltrados.length === 0 && (
                                <li className="px-4 py-6 text-center text-sm text-gray-400">
                                    Sin votantes para "{busqueda}".
                                </li>
                            )}
                        </ul>
                    </section>

                    {/* Columna 3: terminales */}
                    <aside className="bg-white border rounded-2xl p-6 shadow-sm">
                        <p className="text-xs uppercase tracking-wider text-gray-400 font-semibold mb-3">
                            Terminales del puesto
                        </p>
                        <ul className="space-y-2">
                            {vistas.map((v) => (
                                <li
                                    key={v.terminal.id}
                                    className={`border rounded-xl px-4 py-3 ${
                                        v.estado === "LIBRE"
                                            ? "border-green-200 bg-green-50"
                                            : v.estado === "OCUPADA"
                                              ? "border-amber-200 bg-amber-50"
                                              : "border-gray-200 bg-gray-50 opacity-60"
                                    }`}
                                >
                                    <div className="flex items-center justify-between">
                                        <p className="font-bold text-sm">
                                            Terminal #{v.terminal.id}
                                        </p>
                                        <span className="text-[10px] uppercase font-bold tracking-wider">
                                            {v.estado.replace("_", " ")}
                                        </span>
                                    </div>
                                    {v.votanteActualId && (
                                        <p className="text-[11px] text-gray-500 mt-1">
                                            Sesión: votante #{v.votanteActualId}
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </aside>
                </div>

                {mensaje && (
                    <div
                        className={`mt-6 border rounded-xl px-4 py-3 text-sm flex items-start gap-3 ${
                            mensaje.tipo === "ok"
                                ? "bg-green-50 border-green-200 text-green-800"
                                : "bg-red-50 border-red-200 text-red-700"
                        }`}
                    >
                        {mensaje.tipo === "ok" ? (
                            <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
                        ) : (
                            <AlertCircle size={16} className="shrink-0 mt-0.5" />
                        )}
                        <span>{mensaje.texto}</span>
                    </div>
                )}
            </main>

            {sesionAsistida && (
                <DialogoVotoAsistido
                    documentoVotante={sesionAsistida.votante.documento}
                    onCerrar={() => setSesionAsistida(null)}
                    onConfirmar={confirmarVotoAsistido}
                />
            )}
        </div>
    );
}

function FilaVotante({
    votante,
    terminalAsignadaId,
    terminalAsignadaEstado,
    votado,
    verificando,
    onVerificar,
    terminalesDisponibles,
    onAutorizar,
    onAutorizarAsistido,
}: {
    votante: DeploymentVotante;
    terminalAsignadaId: number;
    terminalAsignadaEstado: EstadoTerminal;
    votado: boolean | undefined;
    verificando: boolean;
    onVerificar: () => void;
    terminalesDisponibles: VistaTerminal[];
    onAutorizar: (terminalId: number) => void;
    onAutorizarAsistido: (terminalId: number) => void;
}) {
    const [modoSeleccion, setModoSeleccion] = useState<
        null | "normal" | "asistido"
    >(null);
    const yaVoto = votado === true;
    const terminalNoDisponible = terminalAsignadaEstado !== "LIBRE";

    return (
        <li className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="font-bold text-sm text-gray-800 truncate">
                        {votante.nombre}
                    </p>
                    <p className="text-xs font-mono text-gray-500">
                        Doc {votante.documento}{" "}
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 text-[10px] font-bold uppercase tracking-wider text-gray-600">
                            Terminal #{terminalAsignadaId}
                        </span>
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {votado === undefined && (
                        <button
                            onClick={onVerificar}
                            disabled={verificando}
                            className="border rounded-lg px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                            {verificando ? (
                                <Loader2
                                    size={12}
                                    className="animate-spin"
                                />
                            ) : (
                                "Verificar"
                            )}
                        </button>
                    )}
                    {yaVoto && (
                        <span className="flex items-center gap-1 text-xs text-gray-500 font-bold uppercase">
                            <UserX size={12} />
                            Ya votó
                        </span>
                    )}
                    {votado === false && (
                        <>
                            {terminalNoDisponible ? (
                                <span className="text-[11px] text-gray-400 italic">
                                    {terminalAsignadaEstado === "OCUPADA"
                                        ? "Terminal ocupada"
                                        : "Terminal fuera de servicio"}
                                </span>
                            ) : (
                                <>
                                    <button
                                        onClick={() =>
                                            setModoSeleccion((m) =>
                                                m === "normal" ? null : "normal"
                                            )
                                        }
                                        className="flex items-center gap-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold uppercase tracking-wide px-3 py-1.5 rounded-lg"
                                    >
                                        <UserCheck size={12} />
                                        Autorizar
                                    </button>
                                    <button
                                        onClick={() =>
                                            setModoSeleccion((m) =>
                                                m === "asistido"
                                                    ? null
                                                    : "asistido"
                                            )
                                        }
                                        className="flex items-center gap-1 border border-red-300 bg-white hover:bg-red-50 text-red-600 text-xs font-bold uppercase tracking-wide px-3 py-1.5 rounded-lg"
                                        title="Voto asistido (SE-M3-05)"
                                    >
                                        <Accessibility size={12} />
                                        Asistido
                                    </button>
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>

            {modoSeleccion && votado === false && (
                <div className="mt-2 flex flex-wrap gap-2 items-center">
                    <span className="text-[11px] text-gray-500 font-semibold uppercase tracking-wider">
                        {modoSeleccion === "asistido"
                            ? "Confirmar asistido →"
                            : "Confirmar →"}
                    </span>
                    {terminalesDisponibles.length === 0 && (
                        <span className="text-xs text-gray-400 italic">
                            Terminal asignada no disponible.
                        </span>
                    )}
                    {terminalesDisponibles.map((v) => (
                        <button
                            key={v.terminal.id}
                            onClick={() => {
                                if (modoSeleccion === "asistido") {
                                    onAutorizarAsistido(v.terminal.id);
                                } else {
                                    onAutorizar(v.terminal.id);
                                }
                                setModoSeleccion(null);
                            }}
                            className={`text-xs border font-semibold px-3 py-1 rounded-lg ${
                                modoSeleccion === "asistido"
                                    ? "border-red-300 bg-red-50 hover:bg-red-100 text-red-700"
                                    : "border-green-300 bg-green-50 hover:bg-green-100 text-green-700"
                            }`}
                        >
                            → Terminal #{v.terminal.id}
                        </button>
                    ))}
                </div>
            )}
        </li>
    );
}
