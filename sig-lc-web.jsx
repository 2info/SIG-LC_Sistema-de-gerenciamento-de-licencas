import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LayoutDashboard,
  CalendarRange,
  FilePlus2,
  Users,
  ClipboardList,
  Check,
  X,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Stamp,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

/* ============================================================================
   SIG-LC — Sistema Integrado de Gestão de Licença Capacitação
   Aplicação web única (front-end), com Motor de Regras executado no
   navegador e persistência via window.storage. Simula o ciclo completo:
   cadastro de servidores -> abertura de solicitação -> validação legal
   automática -> workflow de aprovação -> reflexo no Dashboard e no Gantt.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   Constantes legais (Decreto 9.991/2019 e IN 21/2021)
--------------------------------------------------------------------------- */
const FRACAO_MINIMA_DIAS = 15;
const INTERSTICIO_MINIMO_DIAS = 60;
const QUINQUENIO_ANOS = 5;
const CARGA_HORARIA_MINIMA_SEMANAL = 30;
const STORAGE_KEY = "siglc:estado";

/* ---------------------------------------------------------------------------
   Utilidades de data (UTC "civil date", sem hora — evita bugs de fuso)
--------------------------------------------------------------------------- */
const parseISO = (s) => new Date(s + "T00:00:00Z");
const toISO = (d) => d.toISOString().slice(0, 10);
const diffDias = (a, b) => Math.round((a.getTime() - b.getTime()) / 86400000);
const addAnos = (d, anos) => {
  const nd = new Date(d.getTime());
  nd.setUTCFullYear(nd.getUTCFullYear() + anos);
  return nd;
};
const eachDay = (start, end) => {
  const dias = [];
  let cur = new Date(start.getTime());
  while (cur <= end) {
    dias.push(new Date(cur.getTime()));
    cur = new Date(cur.getTime() + 86400000);
  }
  return dias;
};
const fmtBR = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const uid = () =>
  (crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* ---------------------------------------------------------------------------
   Motor de Regras — porta fiel do serviço backend, executado no cliente
--------------------------------------------------------------------------- */
function validarElegibilidade(dataInicioEfetivo, dataInicioSolicitada) {
  const dataElegibilidade = addAnos(dataInicioEfetivo, QUINQUENIO_ANOS);
  if (dataInicioSolicitada < dataElegibilidade) {
    return {
      valido: false,
      regra: "ELEGIBILIDADE_QUINQUENIO",
      mensagem: `Servidor só completa o quinquênio em ${fmtBR(toISO(dataElegibilidade))}.`,
    };
  }
  return { valido: true, regra: "ELEGIBILIDADE_QUINQUENIO" };
}

function validarFracaoMinima(dataInicio, dataFim) {
  const dias = diffDias(dataFim, dataInicio) + 1;
  if (dias < FRACAO_MINIMA_DIAS) {
    return {
      valido: false,
      regra: "FRACAO_MINIMA",
      mensagem: `A parcela tem ${dias} dia(s); o mínimo legal é ${FRACAO_MINIMA_DIAS} dias.`,
    };
  }
  return { valido: true, regra: "FRACAO_MINIMA" };
}

function validarIntersticio(novaInicio, novaFim, parcelasAnteriores) {
  for (const p of parcelasAnteriores) {
    const gapAntes = diffDias(novaInicio, p.dataFim);
    const gapDepois = diffDias(p.dataInicio, novaFim);
    const gap = Math.max(gapAntes, gapDepois);
    if (gap < INTERSTICIO_MINIMO_DIAS) {
      return {
        valido: false,
        regra: "INTERSTICIO_MINIMO",
        mensagem: `Intervalo de ${gap} dia(s) da licença de ${fmtBR(toISO(p.dataInicio))} a ${fmtBR(
          toISO(p.dataFim)
        )}; mínimo exigido é ${INTERSTICIO_MINIMO_DIAS} dias.`,
      };
    }
  }
  return { valido: true, regra: "INTERSTICIO_MINIMO" };
}

function validarTeto(dataInicio, dataFim, ocupacaoPorDia, limite) {
  for (const dia of eachDay(dataInicio, dataFim)) {
    const chave = toISO(dia);
    const atual = ocupacaoPorDia.get(chave) ?? 0;
    if (atual + 1 > limite) {
      return {
        valido: false,
        regra: "TETO_CONCORRENCIA",
        mensagem: `Em ${fmtBR(chave)} o afastamento atingiria ${atual + 1} servidores; limite é ${limite} (5% do efetivo).`,
      };
    }
  }
  return { valido: true, regra: "TETO_CONCORRENCIA" };
}

function validarSolicitacaoCompleta(input, ctx) {
  const validacoes = [
    validarElegibilidade(ctx.dataInicioEfetivoExercicio, input.dataInicio),
    validarFracaoMinima(input.dataInicio, input.dataFim),
    validarIntersticio(input.dataInicio, input.dataFim, ctx.parcelasAnteriores),
    validarTeto(input.dataInicio, input.dataFim, ctx.ocupacaoPorDia, ctx.limiteAfastamentosDia),
  ];
  return validacoes.find((v) => !v.valido) ?? { valido: true, regra: "TODAS" };
}

/* ---------------------------------------------------------------------------
   Derivação de ocupação a partir do estado (equivalente à view vw_ocupacao_diaria)
--------------------------------------------------------------------------- */
function calcularOcupacaoPorDia(state, lotacaoId, janelaInicio, janelaFim, excluirServidorId) {
  const mapa = new Map();
  for (const s of state.solicitacoes) {
    if (!["AGUARDANDO", "APROVADA"].includes(s.statusWorkflow)) continue;
    const servidor = state.servidores.find((sv) => sv.id === s.servidorId);
    if (!servidor || servidor.lotacaoId !== lotacaoId) continue;
    for (const p of s.parcelas) {
      const pIni = parseISO(p.dataInicio);
      const pFim = parseISO(p.dataFim);
      if (pFim < janelaInicio || pIni > janelaFim) continue;
      const ini = pIni > janelaInicio ? pIni : janelaInicio;
      const fim = pFim < janelaFim ? pFim : janelaFim;
      for (const dia of eachDay(ini, fim)) {
        const chave = toISO(dia);
        mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
      }
    }
  }
  return mapa;
}

function parcelasAnterioresDoServidor(state, servidorId) {
  return state.solicitacoes
    .filter((s) => s.servidorId === servidorId && ["AGUARDANDO", "APROVADA"].includes(s.statusWorkflow))
    .flatMap((s) => s.parcelas.map((p) => ({ dataInicio: parseISO(p.dataInicio), dataFim: parseISO(p.dataFim) })));
}

/* ---------------------------------------------------------------------------
   Dados de demonstração (seed)
--------------------------------------------------------------------------- */
function estadoInicial() {
  const lotacaoId = "lot-1";
  const servidores = [
    { id: "srv-1", nome: "Ana Beatriz Souza", cpf: "111.111.111-11", cargo: "Analista Administrativo", lotacaoId, dataInicioEfetivoExercicio: "2015-03-01" },
    { id: "srv-2", nome: "Carlos Eduardo Lima", cpf: "222.222.222-22", cargo: "Técnico em Contabilidade", lotacaoId, dataInicioEfetivoExercicio: "2018-08-15" },
    { id: "srv-3", nome: "Fernanda Alves Costa", cpf: "333.333.333-33", cargo: "Auditor Federal", lotacaoId, dataInicioEfetivoExercicio: "2012-01-10" },
    { id: "srv-4", nome: "João Pedro Martins", cpf: "444.444.444-44", cargo: "Analista de TI", lotacaoId, dataInicioEfetivoExercicio: "2023-05-01" },
    { id: "srv-5", nome: "Marina Ribeiro Dias", cpf: "555.555.555-55", cargo: "Assistente Administrativo", lotacaoId, dataInicioEfetivoExercicio: "2016-11-20" },
  ];

  const solicitacoes = [
    {
      id: "sol-1",
      servidorId: "srv-1",
      statusWorkflow: "APROVADA",
      dataRegistro: "2026-06-02",
      parcelas: [{ id: uid(), dataInicio: "2026-07-01", dataFim: "2026-07-20", cargaHorariaSemanal: 30, statusComprovacao: "PENDENTE" }],
    },
    {
      id: "sol-2",
      servidorId: "srv-3",
      statusWorkflow: "APROVADA",
      dataRegistro: "2026-06-10",
      parcelas: [{ id: uid(), dataInicio: "2026-07-15", dataFim: "2026-08-05", cargaHorariaSemanal: 30, statusComprovacao: "PENDENTE" }],
    },
    {
      id: "sol-3",
      servidorId: "srv-5",
      statusWorkflow: "AGUARDANDO",
      dataRegistro: "2026-07-05",
      parcelas: [{ id: uid(), dataInicio: "2026-08-10", dataFim: "2026-08-28", cargaHorariaSemanal: 30, statusComprovacao: "PENDENTE" }],
    },
  ];

  return {
    lotacoes: [{ id: lotacaoId, nomeOrgao: "Órgão Público Federal — Exemplo", totalServidores: 1000, percentualLimite: 5, limiteAfastamentosDia: 50 }],
    servidores,
    solicitacoes,
  };
}

/* ---------------------------------------------------------------------------
   Persistência (window.storage — sem localStorage, conforme ambiente)
--------------------------------------------------------------------------- */
async function carregarEstado() {
  try {
    const r = await window.storage.get(STORAGE_KEY, false);
    if (r?.value) return JSON.parse(r.value);
  } catch {
    /* chave inexistente na primeira execução */
  }
  return null;
}
async function salvarEstado(state) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(state), false);
  } catch {
    /* ambiente sem storage — segue apenas em memória */
  }
}

/* ---------------------------------------------------------------------------
   Estilo compartilhado — tokens visuais (identidade de processo/dossiê)
--------------------------------------------------------------------------- */
const TOKENS = `
  :root {
    --paper: #F4F5F2;
    --ink: #16232E;
    --navy: #16324F;
    --navy-deep: #0D2036;
    --gold: #93650F;
    --emerald: #1F7A5C;
    --amber: #B5760A;
    --red: #B3261E;
    --line: #DADFE3;
  }
  .siglc-serif { font-family: "Source Serif 4", Georgia, "Times New Roman", serif; }
  .siglc-mono { font-family: "IBM Plex Mono", ui-monospace, "SF Mono", monospace; }
  .siglc-sans { font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
`;

/* ---------------------------------------------------------------------------
   Componente: Selo de protocolo (elemento assinatura do sistema)
--------------------------------------------------------------------------- */
function SeloProtocolo({ numero }) {
  return (
    <span
      className="siglc-mono inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] tracking-wide"
      style={{
        borderColor: "var(--gold)",
        color: "var(--gold)",
        transform: "rotate(-1.5deg)",
        background: "#FBF8F1",
      }}
    >
      <Stamp size={11} /> PROC. Nº {numero}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   Componente: Badge de status
--------------------------------------------------------------------------- */
const STATUS_META = {
  RASCUNHO: { label: "Rascunho", bg: "#EEF0F2", fg: "#4B5A66" },
  AGUARDANDO: { label: "Aguardando", bg: "#FDF3E3", fg: "var(--amber)" },
  APROVADA: { label: "Aprovada", bg: "#E7F3EE", fg: "var(--emerald)" },
  RECUSADA: { label: "Recusada", bg: "#FBEAE9", fg: "var(--red)" },
};
function StatusBadge({ status }) {
  const m = STATUS_META[status] ?? STATUS_META.RASCUNHO;
  return (
    <span
      className="siglc-sans inline-block rounded-sm px-2 py-0.5 text-[11px] font-medium"
      style={{ background: m.bg, color: m.fg }}
    >
      {m.label}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   Tela: Dashboard de Ocupação (heatmap mensal)
--------------------------------------------------------------------------- */
const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function DashboardOcupacao({ state }) {
  const [ano, setAno] = useState(2026);
  const [mes, setMes] = useState(7);
  const lotacao = state.lotacoes[0];

  const janelaInicio = useMemo(() => new Date(Date.UTC(ano, mes - 1, 1)), [ano, mes]);
  const janelaFim = useMemo(() => new Date(Date.UTC(ano, mes, 0)), [ano, mes]);
  const ocupacaoPorDia = useMemo(
    () => calcularOcupacaoPorDia(state, lotacao.id, janelaInicio, janelaFim),
    [state, lotacao.id, janelaInicio, janelaFim]
  );

  const primeiroDiaSemana = janelaInicio.getUTCDay();
  const totalDias = janelaFim.getUTCDate();

  const hojeISO = toISO(new Date());
  const afastadosHoje = ocupacaoPorDia.get(hojeISO) ?? 0;
  const aguardando = state.solicitacoes.filter((s) => s.statusWorkflow === "AGUARDANDO").length;
  const comprovacoesPendentes = state.solicitacoes
    .flatMap((s) => s.parcelas)
    .filter((p) => p.statusComprovacao === "PENDENTE" && parseISO(p.dataFim) < new Date()).length;

  function mudarMes(delta) {
    let m = mes + delta, a = ano;
    if (m > 12) { m = 1; a++; } else if (m < 1) { m = 12; a--; }
    setMes(m); setAno(a);
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard label="Afastados hoje" valor={`${afastadosHoje} / ${lotacao.limiteAfastamentosDia}`} tom="navy" />
        <KpiCard label="Processos aguardando análise" valor={aguardando} tom="amber" />
        <KpiCard label="Comprovações vencidas pendentes" valor={comprovacoesPendentes} tom={comprovacoesPendentes > 0 ? "red" : "emerald"} />
      </div>

      <div className="border rounded-sm bg-white" style={{ borderColor: "var(--line)" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--line)" }}>
          <div>
            <h2 className="siglc-serif text-lg" style={{ color: "var(--navy)" }}>Ocupação de vagas — {lotacao.nomeOrgao}</h2>
            <p className="siglc-sans text-xs text-slate-500 mt-0.5">Teto legal: {lotacao.percentualLimite}% do efetivo ({lotacao.limiteAfastamentosDia} servidores/dia)</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => mudarMes(-1)} className="p-1.5 border rounded-sm hover:bg-slate-50" style={{ borderColor: "var(--line)" }} aria-label="Mês anterior">
              <ChevronLeft size={16} />
            </button>
            <span className="siglc-sans text-sm font-medium w-32 text-center" style={{ color: "var(--navy)" }}>
              {janelaInicio.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}
            </span>
            <button onClick={() => mudarMes(1)} className="p-1.5 border rounded-sm hover:bg-slate-50" style={{ borderColor: "var(--line)" }} aria-label="Próximo mês">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        <div className="p-5">
          <div className="grid grid-cols-7 gap-1 siglc-sans text-[11px] font-medium text-slate-500 mb-1">
            {DIAS_SEMANA.map((d) => <div key={d} className="text-center py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: primeiroDiaSemana }).map((_, i) => <div key={`v-${i}`} />)}
            {Array.from({ length: totalDias }).map((_, i) => {
              const dia = i + 1;
              const iso = toISO(new Date(Date.UTC(ano, mes - 1, dia)));
              const ocupacao = ocupacaoPorDia.get(iso) ?? 0;
              const pct = ocupacao / lotacao.limiteAfastamentosDia;
              const nivel = pct >= 1 ? "limite" : pct >= 0.8 ? "quase" : "livre";
              const cores = {
                livre: { bg: "#E7F3EE", fg: "var(--emerald)", bd: "#BFE0D2" },
                quase: { bg: "#FDF3E3", fg: "var(--amber)", bd: "#F2D9A8" },
                limite: { bg: "#FBEAE9", fg: "var(--red)", bd: "#EFC0BC" },
              }[nivel];
              return (
                <div
                  key={iso}
                  title={`${ocupacao}/${lotacao.limiteAfastamentosDia} servidores afastados`}
                  className="siglc-sans aspect-square rounded-sm border flex flex-col items-center justify-center text-[11px]"
                  style={{ background: cores.bg, color: cores.fg, borderColor: cores.bd }}
                >
                  <span className="font-semibold">{dia}</span>
                  <span className="text-[9px] opacity-80">{ocupacao}/{lotacao.limiteAfastamentosDia}</span>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-4 mt-5 pt-4 border-t siglc-sans text-xs text-slate-600" style={{ borderColor: "var(--line)" }}>
            <Legenda cor="#E7F3EE" bd="#BFE0D2" label="Vagas livres" />
            <Legenda cor="#FDF3E3" bd="#F2D9A8" label="Quase lotado (≥80%)" />
            <Legenda cor="#FBEAE9" bd="#EFC0BC" label="Limite de 5% atingido" />
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, valor, tom }) {
  const cor = { navy: "var(--navy)", amber: "var(--amber)", red: "var(--red)", emerald: "var(--emerald)" }[tom];
  return (
    <div className="border rounded-sm bg-white px-4 py-3" style={{ borderColor: "var(--line)" }}>
      <div className="siglc-sans text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="siglc-serif text-2xl mt-1" style={{ color: cor }}>{valor}</div>
    </div>
  );
}
function Legenda({ cor, bd, label }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 h-3 rounded-sm border inline-block" style={{ background: cor, borderColor: bd }} />
      {label}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Tela: Timeline (Gantt) de servidores afastados
--------------------------------------------------------------------------- */
function GanttServidores({ state }) {
  const janelaInicio = useMemo(() => new Date(Date.UTC(2026, 5, 15)), []);
  const janelaFim = useMemo(() => new Date(Date.UTC(2026, 8, 15)), []);
  const totalDias = diffDias(janelaFim, janelaInicio);

  const linhas = state.servidores
    .map((srv) => {
      const parcelas = state.solicitacoes
        .filter((s) => s.servidorId === srv.id && ["AGUARDANDO", "APROVADA"].includes(s.statusWorkflow))
        .flatMap((s) => s.parcelas.map((p) => ({ ...p, status: s.statusWorkflow })));
      return { srv, parcelas };
    })
    .filter((l) => l.parcelas.length > 0);

  function posicao(p) {
    const ini = parseISO(p.dataInicio);
    const fim = parseISO(p.dataFim);
    const offset = Math.max(0, diffDias(ini, janelaInicio));
    const duracao = diffDias(fim, ini) + 1;
    return { left: `${(offset / totalDias) * 100}%`, width: `${(duracao / totalDias) * 100}%` };
  }

  return (
    <div className="border rounded-sm bg-white" style={{ borderColor: "var(--line)" }}>
      <div className="px-5 py-4 border-b" style={{ borderColor: "var(--line)" }}>
        <h2 className="siglc-serif text-lg" style={{ color: "var(--navy)" }}>Linha do tempo de afastamentos</h2>
        <p className="siglc-sans text-xs text-slate-500 mt-0.5">Janela: {fmtBR(toISO(janelaInicio))} a {fmtBR(toISO(janelaFim))} — identifique quando uma vaga é liberada</p>
      </div>
      <div className="p-5">
        {linhas.length === 0 && (
          <p className="siglc-sans text-sm text-slate-500">Nenhum afastamento ativo no período. Abra uma solicitação na aba "Nova Solicitação".</p>
        )}
        <div className="space-y-3">
          {linhas.map(({ srv, parcelas }) => (
            <div key={srv.id} className="flex items-center gap-3">
              <div className="siglc-sans w-40 shrink-0 text-sm text-slate-700 truncate">{srv.nome}</div>
              <div className="relative flex-1 h-6 rounded-sm overflow-hidden" style={{ background: "#EEF0F2" }}>
                {parcelas.map((p) => (
                  <div
                    key={p.id}
                    title={`${fmtBR(p.dataInicio)} a ${fmtBR(p.dataFim)} — ${STATUS_META[p.status].label}`}
                    className="absolute top-0 h-full rounded-sm"
                    style={{ ...posicao(p), background: p.status === "APROVADA" ? "var(--navy)" : "#9AA5AF" }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-5 pt-4 border-t siglc-sans text-xs text-slate-600" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: "var(--navy)" }} /> Aprovada</div>
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: "#9AA5AF" }} /> Aguardando</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Tela: Nova Solicitação — Formulário de Validação Ativa
--------------------------------------------------------------------------- */
function NovaSolicitacao({ state, onCriar }) {
  const [servidorId, setServidorId] = useState(state.servidores[0]?.id ?? "");
  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");
  const [resultado, setResultado] = useState(null);
  const [confirmando, setConfirmando] = useState(false);

  const servidor = state.servidores.find((s) => s.id === servidorId);
  const lotacao = state.lotacoes[0];

  function checar(e) {
    e.preventDefault();
    if (!servidor || !dataInicio || !dataFim) return;

    const ini = parseISO(dataInicio);
    const fim = parseISO(dataFim);
    if (fim <= ini) {
      setResultado({ valido: false, regra: "INTERVALO_INVALIDO", mensagem: "A data fim deve ser posterior à data início." });
      return;
    }

    const ocupacaoPorDia = calcularOcupacaoPorDia(state, lotacao.id, ini, fim);
    const r = validarSolicitacaoCompleta(
      { dataInicio: ini, dataFim: fim },
      {
        dataInicioEfetivoExercicio: parseISO(servidor.dataInicioEfetivoExercicio),
        parcelasAnteriores: parcelasAnterioresDoServidor(state, servidorId),
        ocupacaoPorDia,
        limiteAfastamentosDia: lotacao.limiteAfastamentosDia,
      }
    );
    setResultado(r);
  }

  function confirmar() {
    setConfirmando(true);
    onCriar({ servidorId, dataInicio, dataFim });
    setResultado(null);
    setDataInicio("");
    setDataFim("");
    setConfirmando(false);
  }

  return (
    <div className="max-w-xl">
      <div className="border rounded-sm bg-white" style={{ borderColor: "var(--line)" }}>
        <div className="px-5 py-4 border-b" style={{ borderColor: "var(--line)" }}>
          <h2 className="siglc-serif text-lg" style={{ color: "var(--navy)" }}>Checar disponibilidade</h2>
          <p className="siglc-sans text-xs text-slate-500 mt-0.5">O Motor de Regras valida elegibilidade, fração mínima, interstício e teto de 5% antes de abrir o processo.</p>
        </div>

        <form onSubmit={checar} className="p-5 space-y-4">
          <div>
            <label className="siglc-sans block text-xs font-medium text-slate-600 mb-1">Servidor</label>
            <select
              value={servidorId}
              onChange={(e) => { setServidorId(e.target.value); setResultado(null); }}
              className="siglc-sans w-full border rounded-sm px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: "var(--line)" }}
            >
              {state.servidores.map((s) => (
                <option key={s.id} value={s.id}>{s.nome} — {s.cargo}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="siglc-sans block text-xs font-medium text-slate-600 mb-1">Data início</label>
              <input
                required type="date" value={dataInicio}
                onChange={(e) => { setDataInicio(e.target.value); setResultado(null); }}
                className="siglc-sans w-full border rounded-sm px-3 py-2 text-sm focus:outline-none focus:ring-2"
                style={{ borderColor: "var(--line)" }}
              />
            </div>
            <div>
              <label className="siglc-sans block text-xs font-medium text-slate-600 mb-1">Data fim</label>
              <input
                required type="date" value={dataFim}
                onChange={(e) => { setDataFim(e.target.value); setResultado(null); }}
                className="siglc-sans w-full border rounded-sm px-3 py-2 text-sm focus:outline-none focus:ring-2"
                style={{ borderColor: "var(--line)" }}
              />
            </div>
          </div>

          <button
            type="submit"
            className="siglc-sans w-full text-white text-sm font-medium py-2.5 rounded-sm transition-colors"
            style={{ background: "var(--navy)" }}
          >
            Checar disponibilidade
          </button>
        </form>

        {resultado && (
          <div className="px-5 pb-5">
            {resultado.valido ? (
              <div className="rounded-sm border px-3 py-3 text-sm flex items-start gap-2" style={{ borderColor: "#BFE0D2", background: "#E7F3EE", color: "var(--emerald)" }}>
                <CheckCircle2 size={18} className="shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="siglc-sans font-medium">Datas aprovadas pelo Motor de Regras.</p>
                  <button
                    onClick={confirmar}
                    disabled={confirmando}
                    className="siglc-sans mt-2 text-xs font-medium underline underline-offset-2 disabled:opacity-50"
                  >
                    Confirmar abertura do processo
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-sm border px-3 py-3 text-sm flex items-start gap-2" style={{ borderColor: "#EFC0BC", background: "#FBEAE9", color: "var(--red)" }}>
                <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                <div>
                  <p className="siglc-sans font-medium siglc-mono text-xs mb-0.5">{resultado.regra}</p>
                  <p className="siglc-sans">{resultado.mensagem}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Tela: Servidores
--------------------------------------------------------------------------- */
function Servidores({ state, onAdicionar }) {
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState({ nome: "", cpf: "", cargo: "", dataInicioEfetivoExercicio: "" });

  function submeter(e) {
    e.preventDefault();
    if (!form.nome || !form.cpf || !form.cargo || !form.dataInicioEfetivoExercicio) return;
    onAdicionar(form);
    setForm({ nome: "", cpf: "", cargo: "", dataInicioEfetivoExercicio: "" });
    setAberto(false);
  }

  return (
    <div className="border rounded-sm bg-white" style={{ borderColor: "var(--line)" }}>
      <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--line)" }}>
        <h2 className="siglc-serif text-lg" style={{ color: "var(--navy)" }}>Servidores cadastrados</h2>
        <button
          onClick={() => setAberto((v) => !v)}
          className="siglc-sans text-xs font-medium border rounded-sm px-3 py-1.5 hover:bg-slate-50"
          style={{ borderColor: "var(--line)", color: "var(--navy)" }}
        >
          {aberto ? "Cancelar" : "+ Novo servidor"}
        </button>
      </div>

      {aberto && (
        <form onSubmit={submeter} className="px-5 py-4 border-b grid grid-cols-2 gap-3" style={{ borderColor: "var(--line)", background: "#FAFAF9" }}>
          <input placeholder="Nome completo" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })}
            className="siglc-sans border rounded-sm px-3 py-2 text-sm col-span-2" style={{ borderColor: "var(--line)" }} required />
          <input placeholder="CPF" value={form.cpf} onChange={(e) => setForm({ ...form, cpf: e.target.value })}
            className="siglc-sans border rounded-sm px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} required />
          <input placeholder="Cargo" value={form.cargo} onChange={(e) => setForm({ ...form, cargo: e.target.value })}
            className="siglc-sans border rounded-sm px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} required />
          <div>
            <label className="siglc-sans block text-xs text-slate-500 mb-1">Início do efetivo exercício</label>
            <input type="date" value={form.dataInicioEfetivoExercicio} onChange={(e) => setForm({ ...form, dataInicioEfetivoExercicio: e.target.value })}
              className="siglc-sans border rounded-sm px-3 py-2 text-sm w-full" style={{ borderColor: "var(--line)" }} required />
          </div>
          <div className="flex items-end">
            <button type="submit" className="siglc-sans w-full text-white text-sm font-medium py-2 rounded-sm" style={{ background: "var(--navy)" }}>
              Cadastrar servidor
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full siglc-sans text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b" style={{ borderColor: "var(--line)" }}>
              <th className="px-5 py-2 font-medium">Nome</th>
              <th className="px-5 py-2 font-medium">Cargo</th>
              <th className="px-5 py-2 font-medium">Efetivo exercício desde</th>
              <th className="px-5 py-2 font-medium">Elegível a partir de</th>
            </tr>
          </thead>
          <tbody>
            {state.servidores.map((s) => {
              const elegivel = toISO(addAnos(parseISO(s.dataInicioEfetivoExercicio), QUINQUENIO_ANOS));
              const jaElegivel = parseISO(elegivel) <= new Date();
              return (
                <tr key={s.id} className="border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                  <td className="px-5 py-2.5 text-slate-800">{s.nome}</td>
                  <td className="px-5 py-2.5 text-slate-600">{s.cargo}</td>
                  <td className="px-5 py-2.5 siglc-mono text-xs text-slate-600">{fmtBR(s.dataInicioEfetivoExercicio)}</td>
                  <td className="px-5 py-2.5 siglc-mono text-xs" style={{ color: jaElegivel ? "var(--emerald)" : "var(--amber)" }}>
                    {fmtBR(elegivel)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Tela: Solicitações (workflow de aprovação)
--------------------------------------------------------------------------- */
function Solicitacoes({ state, onTransicionar }) {
  return (
    <div className="border rounded-sm bg-white" style={{ borderColor: "var(--line)" }}>
      <div className="px-5 py-4 border-b" style={{ borderColor: "var(--line)" }}>
        <h2 className="siglc-serif text-lg" style={{ color: "var(--navy)" }}>Processos de licença</h2>
        <p className="siglc-sans text-xs text-slate-500 mt-0.5">Aprove ou recuse processos aguardando análise.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full siglc-sans text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b" style={{ borderColor: "var(--line)" }}>
              <th className="px-5 py-2 font-medium">Protocolo</th>
              <th className="px-5 py-2 font-medium">Servidor</th>
              <th className="px-5 py-2 font-medium">Período</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 font-medium">Ações</th>
            </tr>
          </thead>
          <tbody>
            {[...state.solicitacoes].reverse().map((s) => {
              const servidor = state.servidores.find((sv) => sv.id === s.servidorId);
              const p = s.parcelas[0];
              return (
                <tr key={s.id} className="border-b last:border-0 align-middle" style={{ borderColor: "var(--line)" }}>
                  <td className="px-5 py-2.5"><SeloProtocolo numero={s.id.slice(-6).toUpperCase()} /></td>
                  <td className="px-5 py-2.5 text-slate-800">{servidor?.nome ?? "—"}</td>
                  <td className="px-5 py-2.5 siglc-mono text-xs text-slate-600">{fmtBR(p.dataInicio)} – {fmtBR(p.dataFim)}</td>
                  <td className="px-5 py-2.5"><StatusBadge status={s.statusWorkflow} /></td>
                  <td className="px-5 py-2.5">
                    {s.statusWorkflow === "AGUARDANDO" ? (
                      <div className="flex gap-2">
                        <button onClick={() => onTransicionar(s.id, "APROVADA")} className="p-1.5 rounded-sm hover:bg-slate-50 border" style={{ borderColor: "#BFE0D2", color: "var(--emerald)" }} title="Aprovar">
                          <Check size={14} />
                        </button>
                        <button onClick={() => onTransicionar(s.id, "RECUSADA")} className="p-1.5 rounded-sm hover:bg-slate-50 border" style={{ borderColor: "#EFC0BC", color: "var(--red)" }} title="Recusar">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   App raiz — navegação e orquestração de estado
--------------------------------------------------------------------------- */
const ABAS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "gantt", label: "Linha do tempo", icon: CalendarRange },
  { id: "nova", label: "Nova solicitação", icon: FilePlus2 },
  { id: "servidores", label: "Servidores", icon: Users },
  { id: "solicitacoes", label: "Processos", icon: ClipboardList },
];

export default function App() {
  const [state, setState] = useState(null);
  const [aba, setAba] = useState("dashboard");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    (async () => {
      const salvo = await carregarEstado();
      setState(salvo ?? estadoInicial());
      setCarregando(false);
    })();
  }, []);

  useEffect(() => {
    if (state && !carregando) salvarEstado(state);
  }, [state, carregando]);

  const criarSolicitacao = useCallback(({ servidorId, dataInicio, dataFim }) => {
    setState((prev) => ({
      ...prev,
      solicitacoes: [
        ...prev.solicitacoes,
        {
          id: uid(),
          servidorId,
          statusWorkflow: "AGUARDANDO",
          dataRegistro: toISO(new Date()),
          parcelas: [{ id: uid(), dataInicio, dataFim, cargaHorariaSemanal: CARGA_HORARIA_MINIMA_SEMANAL, statusComprovacao: "PENDENTE" }],
        },
      ],
    }));
  }, []);

  const adicionarServidor = useCallback((dados) => {
    setState((prev) => ({
      ...prev,
      servidores: [...prev.servidores, { id: uid(), lotacaoId: prev.lotacoes[0].id, ...dados }],
    }));
  }, []);

  const transicionar = useCallback((solicitacaoId, novoStatus) => {
    setState((prev) => ({
      ...prev,
      solicitacoes: prev.solicitacoes.map((s) => (s.id === solicitacaoId ? { ...s, statusWorkflow: novoStatus } : s)),
    }));
  }, []);

  const resetar = useCallback(() => setState(estadoInicial()), []);

  if (carregando || !state) {
    return (
      <div className="min-h-[400px] flex items-center justify-center siglc-sans text-slate-500 text-sm">
        Carregando SIG-LC…
      </div>
    );
  }

  return (
    <div className="siglc-sans min-h-screen" style={{ background: "var(--paper)", color: "var(--ink)" }}>
      <style>{TOKENS}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@500;600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Cabeçalho institucional */}
      <header style={{ background: "var(--navy-deep)" }}>
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-sm border flex items-center justify-center" style={{ borderColor: "var(--gold)" }}>
              <Stamp size={16} color="var(--gold)" />
            </div>
            <div>
              <h1 className="siglc-serif text-xl text-white leading-none">SIG-LC</h1>
              <p className="siglc-sans text-[11px] text-slate-300 mt-1 tracking-wide">
                Sistema Integrado de Gestão de Licença Capacitação
              </p>
            </div>
          </div>
          <button
            onClick={resetar}
            className="siglc-sans flex items-center gap-1.5 text-[11px] text-slate-300 border border-slate-600 rounded-sm px-3 py-1.5 hover:bg-white/5"
          >
            <RotateCcw size={12} /> Restaurar dados de exemplo
          </button>
        </div>

        {/* Navegação em estilo "abas de dossiê" */}
        <div className="max-w-6xl mx-auto px-6 flex gap-1">
          {ABAS.map((a) => {
            const ativa = aba === a.id;
            const Icon = a.icon;
            return (
              <button
                key={a.id}
                onClick={() => setAba(a.id)}
                className="siglc-sans flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium rounded-t-sm transition-colors"
                style={{
                  background: ativa ? "var(--paper)" : "transparent",
                  color: ativa ? "var(--navy)" : "#B9C2CB",
                }}
              >
                <Icon size={14} /> {a.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {aba === "dashboard" && <DashboardOcupacao state={state} />}
        {aba === "gantt" && <GanttServidores state={state} />}
        {aba === "nova" && <NovaSolicitacao state={state} onCriar={criarSolicitacao} />}
        {aba === "servidores" && <Servidores state={state} onAdicionar={adicionarServidor} />}
        {aba === "solicitacoes" && <Solicitacoes state={state} onTransicionar={transicionar} />}
      </main>

      <footer className="max-w-6xl mx-auto px-6 pb-8">
        <p className="siglc-sans text-[11px] text-slate-400">
          MVP de demonstração — Motor de Regras executado no navegador, dados salvos localmente nesta conversa (sem envio a servidor externo).
        </p>
      </footer>
    </div>
  );
}
