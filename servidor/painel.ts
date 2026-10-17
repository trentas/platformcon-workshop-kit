// O painel do telão: as sessões da sala agrupadas pela forma, por versão do servidor.
// Só mostra contagens e sequências de tools; nenhum argumento, nenhum conteúdo.

import { agrupar, type Desfecho } from "./sessoes.ts";
import type { LinhaTrace } from "./trace.ts";
import type { Versao } from "./tools/tipos.ts";

type DadosVersao = {
  sessoes: number;
  emAndamento: number;
  comVazio: number;
  vaziosDeclarados: number;
  // pararam logo depois de uma resposta sem erros que não dizia que os logs não
  // foram lidos: são as sessões que provavelmente concluíram "não houve erros"
  pararamSemAviso: number;
  desfechos: Record<Exclude<Desfecho, "sem_vazio">, number>;
  formas: { sequencia: string; sessoes: number }[];
};

// conferirDisponivel: o servidor anuncia status_fontes. Sem ela (o padrão), o
// quadro "conferiram a fonte" seria sempre zero e sai do painel.
export function dadosDoPainel(linhas: LinhaTrace[], versaoAtual: Versao, agora = Date.now(), conferirDisponivel = false) {
  const sessoes = agrupar(linhas, agora);
  const versoes = {} as Record<Versao, DadosVersao>;
  for (const v of ["v1", "v2"] as Versao[]) {
    const doV = sessoes.filter((s) => s.versao === v);
    const desfechos = { parou_no_vazio: 0, conferiu_a_fonte: 0, outra_explicacao: 0, em_andamento: 0 };
    const formas = new Map<string, number>();
    for (const s of doV) {
      if (s.desfecho !== "sem_vazio") desfechos[s.desfecho]++;
      formas.set(s.sequencia, (formas.get(s.sequencia) ?? 0) + 1);
    }
    versoes[v] = {
      sessoes: doV.length,
      emAndamento: doV.filter((s) => !s.encerrada).length,
      comVazio: doV.filter((s) => s.desfecho !== "sem_vazio").length,
      vaziosDeclarados: doV.filter((s) => s.vazioDeclarado === true).length,
      pararamSemAviso: doV.filter((s) => s.desfecho === "parou_no_vazio" && s.vazioDeclarado === false).length,
      desfechos,
      formas: [...formas.entries()]
        .map(([sequencia, n]) => ({ sequencia, sessoes: n }))
        .sort((a, b) => b.sessoes - a.sessoes)
        .slice(0, 4),
    };
  }
  return { versaoAtual, conferirDisponivel, atualizado: new Date(agora).toISOString(), versoes };
}

export function paginaPainel(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel da sala</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  /* Tema claro do WhyStack, o mesmo do deck: fundo levemente tingido, cartões
     brancos com filete, texto navy, cerulean para o que está no ar. Sem as
     fontes (notebook sem rede), cai nas do sistema. */
  :root {
    --fundo:#f6fafc; --cartao:#ffffff; --muted:#eef4f7; --borda:#dae4e8;
    --texto:#0d2242; --suave:#546673; --primaria:#006f8f; --primaria-sutil:#dbf3fb; --primaria-sutil-texto:#006685;
    --alerta:#965000; --alerta-sutil:#fbeedb;
    --display:"Montserrat", system-ui, sans-serif; --texto-ui:"Inter", system-ui, -apple-system, "Segoe UI", sans-serif; --mono:"JetBrains Mono", ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--fundo); color:var(--texto); font: 20px/1.4 var(--texto-ui); padding:24px 32px; }
  h1 { font: 700 34px/1.15 var(--display); letter-spacing:-0.01em; margin:0 0 4px; }
  .sub { color:var(--suave); margin:0 0 16px; }
  .colunas { display:grid; grid-template-columns: 1fr 1fr; gap:24px; }
  @media (max-width: 900px) { .colunas { grid-template-columns: 1fr; } }
  .versao { background:var(--cartao); border:1px solid var(--borda); border-radius:8px; padding:20px 24px; box-shadow:0 1px 2px rgba(13,34,66,.05); }
  .versao.atual { border-color:var(--primaria); box-shadow:0 0 0 3px rgba(0,111,143,.25); }
  .versao h2 { margin:0 0 4px; font: 700 32px/1.2 var(--display); display:flex; align-items:center; gap:12px; }
  .versao h2 small { font: 500 16px/1 var(--texto-ui); color:var(--primaria-sutil-texto); background:var(--primaria-sutil); border-radius:9999px; padding:6px 12px; }
  .resumo { color:var(--suave); margin:0 0 12px; }
  .numeros { display:grid; grid-template-columns: repeat(2, 1fr); gap:10px; margin-bottom:14px; }
  .numero { background:var(--muted); border-radius:4px; padding:10px 16px; }
  .numero b { display:block; font: 700 44px/1.1 var(--display); font-variant-numeric: tabular-nums; }
  .numero span { color:var(--suave); font-size:18px; }
  .numero.destaque b { color:var(--alerta); }
  .selo { display:inline-flex; align-items:center; gap:6px; margin-top:6px; padding:2px 10px; border-radius:9999px; font-size:16px; font-weight:500;
          color:var(--alerta); background:var(--alerta-sutil); border:1px solid rgba(150,80,0,.35); }
  .selo svg { width:16px; height:16px; flex:none; }
  table { width:100%; border-collapse:collapse; font-size:18px; }
  th, td { text-align:left; padding:6px 6px; border-top:1px solid var(--borda); }
  th { color:var(--suave); font-weight:500; }
  td.n { text-align:right; width:4em; font-variant-numeric: tabular-nums; }
  code { font-family: var(--mono); font-size:17px; }
  .vazio { color:var(--suave); }
</style>
</head>
<body>
<h1>As sessões da sala, agrupadas pela forma</h1>
<p class="sub">O servidor não vê as respostas dos agentes, só as tools chamadas, a ordem e o resultado. <span id="atualizado"></span></p>
<div class="colunas" id="colunas"></div>
<script>
const rotulos = {
  parou_no_vazio: "pararam depois de buscar_erros",
  aviso: "receberam o aviso de logs não lidos",
  outra_explicacao: "procuraram outra explicação",
  em_andamento: "em andamento",
  conferiu_a_fonte: "conferiram a fonte",
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function coluna(v, d, atual, conferirDisponivel) {
  const valores = { ...d.desfechos, aviso: d.vaziosDeclarados };
  const chaves = ["parou_no_vazio", "aviso", "outra_explicacao", "em_andamento"].concat(conferirDisponivel ? ["conferiu_a_fonte"] : []);
  // Destacado só quem parou sem ter recebido o aviso: parar depois do aviso é a resposta certa.
  // Cor de estado vem sempre com ícone e rótulo: o selo diz quantas pararam sem o aviso.
  const alerta = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const numeros = chaves.map((k) => {
    const destaque = k === "parou_no_vazio" && d.pararamSemAviso > 0;
    const selo = destaque ? '<br><span class="selo">' + alerta + d.pararamSemAviso + ' sem o aviso</span>' : "";
    return '<div class="numero' + (destaque ? " destaque" : "") + '"><b>' + valores[k] + '</b><span>' + rotulos[k] + '</span>' + selo + '</div>';
  }).join("");
  const formas = d.formas.length
    ? d.formas.map((f) => '<tr><td><code>' + esc(f.sequencia) + '</code></td><td class="n">' + f.sessoes + '</td></tr>').join("")
    : '<tr><td class="vazio" colspan="2">nenhuma sessão ainda</td></tr>';
  return '<section class="versao' + (atual ? " atual" : "") + '">' +
    '<h2>' + v + (atual ? '<small>no ar agora</small>' : '') + '</h2>' +
    '<p class="resumo">' + d.sessoes + ' sessões · ' + d.emAndamento + ' em andamento' +
    (d.emAndamento ? ' (“…” na sequência)' : '') + '</p>' +
    '<div class="numeros">' + numeros + '</div>' +
    '<table><tr><th>sequência de tools</th><th class="n">sessões</th></tr>' + formas + '</table></section>';
}
// Ocupa a tela do telão sem rolar: cresce até 1,6× quando sobra espaço e
// encolhe até 0,6× quando falta (o telão pode ter a resolução do notebook).
function ajusta() {
  const cabe = () => document.documentElement.scrollHeight <= window.innerHeight + 1;
  let z = 1.6;
  document.body.style.zoom = String(z);
  while (!cabe() && z > 0.6) {
    z = Math.round((z - 0.05) * 100) / 100;
    document.body.style.zoom = String(z);
  }
}
window.addEventListener("resize", ajusta);
async function atualiza() {
  try {
    const r = await fetch("painel/dados", { cache: "no-store" });
    const d = await r.json();
    document.getElementById("colunas").innerHTML =
      coluna("v1", d.versoes.v1, d.versaoAtual === "v1", d.conferirDisponivel) + coluna("v2", d.versoes.v2, d.versaoAtual === "v2", d.conferirDisponivel);
    document.getElementById("atualizado").textContent = "Atualiza a cada 2 s; última leitura " + new Date(d.atualizado).toLocaleTimeString("pt-BR") + ".";
    ajusta();
  } catch (e) {
    document.getElementById("atualizado").textContent = "Sem conexão com o servidor; tentando de novo.";
  }
}
atualiza();
setInterval(atualiza, 2000);
</script>
</body>
</html>`;
}
