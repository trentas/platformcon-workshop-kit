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
  desfechos: Record<Exclude<Desfecho, "sem_vazio">, number>;
  formas: { sequencia: string; sessoes: number }[];
};

export function dadosDoPainel(linhas: LinhaTrace[], versaoAtual: Versao, agora = Date.now()) {
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
      desfechos,
      formas: [...formas.entries()]
        .map(([sequencia, n]) => ({ sequencia, sessoes: n }))
        .sort((a, b) => b.sessoes - a.sessoes)
        .slice(0, 8),
    };
  }
  return { versaoAtual, atualizado: new Date(agora).toISOString(), versoes };
}

export function paginaPainel(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel da sala</title>
<style>
  :root { --fundo:#12161C; --cartao:#1C222B; --borda:#2C3440; --texto:#F4F1EA; --suave:#B8C2CC; --apagado:#8A95A1; --ambar:#E8A33D; --azul:#5B9BD5; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--fundo); color:var(--texto); font: 20px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; padding:32px; }
  h1 { font-size:36px; margin:0 0 4px; }
  .sub { color:var(--apagado); margin:0 0 24px; }
  .colunas { display:grid; grid-template-columns: 1fr 1fr; gap:24px; }
  @media (max-width: 900px) { .colunas { grid-template-columns: 1fr; } }
  .versao { background:var(--cartao); border:1px solid var(--borda); border-radius:16px; padding:24px; }
  .versao.atual { border-color:var(--ambar); }
  .versao h2 { margin:0 0 4px; font-size:32px; }
  .versao h2 small { font-size:18px; color:var(--ambar); font-weight:500; margin-left:12px; }
  .resumo { color:var(--suave); margin:0 0 16px; }
  .numeros { display:grid; grid-template-columns: repeat(2, 1fr); gap:12px; margin-bottom:20px; }
  .numero { background:var(--fundo); border-radius:12px; padding:14px 16px; }
  .numero b { display:block; font-size:44px; line-height:1.1; }
  .numero span { color:var(--suave); font-size:18px; }
  .numero.destaque b { color:var(--ambar); }
  table { width:100%; border-collapse:collapse; font-size:18px; }
  th, td { text-align:left; padding:8px 6px; border-top:1px solid var(--borda); }
  th { color:var(--apagado); font-weight:500; }
  td.n { text-align:right; width:4em; font-variant-numeric: tabular-nums; }
  code { font-family: ui-monospace, "JetBrains Mono", monospace; font-size:17px; }
  .vazio { color:var(--apagado); }
</style>
</head>
<body>
<h1>As sessões da sala, agrupadas pela forma</h1>
<p class="sub">O servidor não vê as respostas dos agentes: só quais tools foram chamadas, em que ordem e com que resultado. Atualiza a cada 2 s. <span id="atualizado"></span></p>
<div class="colunas" id="colunas"></div>
<script>
const rotulos = {
  parou_no_vazio: "pararam depois de buscar_erros",
  conferiu_a_fonte: "conferiram a fonte",
  outra_explicacao: "procuraram outra explicação",
  em_andamento: "em andamento",
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function coluna(v, d, atual) {
  const numeros = Object.entries(rotulos).map(([k, r]) =>
    '<div class="numero' + (k === "parou_no_vazio" ? " destaque" : "") + '"><b>' + d.desfechos[k] + '</b><span>' + r + '</span></div>').join("");
  const formas = d.formas.length
    ? d.formas.map((f) => '<tr><td><code>' + esc(f.sequencia) + '</code></td><td class="n">' + f.sessoes + '</td></tr>').join("")
    : '<tr><td class="vazio" colspan="2">nenhuma sessão ainda</td></tr>';
  return '<section class="versao' + (atual ? " atual" : "") + '">' +
    '<h2>' + v + (atual ? '<small>no ar agora</small>' : '') + '</h2>' +
    '<p class="resumo">' + d.sessoes + ' sessões, ' + d.emAndamento + ' em andamento · ' +
    d.vaziosDeclarados + ' de ' + d.comVazio + ' respostas sem erros declararam a fonte não lida</p>' +
    '<div class="numeros">' + numeros + '</div>' +
    '<table><tr><th>sequência de tools</th><th class="n">sessões</th></tr>' + formas + '</table></section>';
}
async function atualiza() {
  try {
    const r = await fetch("painel/dados", { cache: "no-store" });
    const d = await r.json();
    document.getElementById("colunas").innerHTML =
      coluna("v1", d.versoes.v1, d.versaoAtual === "v1") + coluna("v2", d.versoes.v2, d.versaoAtual === "v2");
    document.getElementById("atualizado").textContent = "Última leitura: " + new Date(d.atualizado).toLocaleTimeString("pt-BR") + ".";
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
