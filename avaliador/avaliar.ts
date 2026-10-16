// O avaliador da estação 1: lê os traces da sala e escreve um rascunho de issue.
//
//   node avaliador/avaliar.ts --traces traces/sala.jsonl [--versao v1] [--modelo claude-opus-5-5] [--seco]
//   node avaliador/avaliar.ts --url http://127.0.0.1:3001/admin/traces   (os traces do servidor no ar)
//
// A divisão de trabalho é a que o rascunho mostra: o OBSERVADO é calculado aqui,
// por código, a partir dos traces, e pode ser conferido linha a linha. O modelo
// recebe esse observado pronto e escreve só a classificação e a HIPÓTESE de
// causa, que fica marcada como hipótese. Com --seco, nada vai ao modelo.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { agrupar, ehVazioDeErros, type Sessao } from "../servidor/sessoes.ts";
import { lerTraces, type LinhaTrace } from "../servidor/trace.ts";
import { estadoDasFontes } from "../servidor/backend.ts";
import { tools } from "../servidor/tools/index.ts";
import type { Versao } from "../servidor/tools/tipos.ts";

const arg = (nome: string, padrao = "") => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : padrao;
};
const flag = (nome: string) => process.argv.includes(`--${nome}`);

const versao = (arg("versao", "v1") === "v2" ? "v2" : "v1") as Versao;
const modelo = arg("modelo", process.env.AVALIADOR_MODELO ?? "claude-opus-5-5");
const seco = flag("seco");

const rubrica = readFileSync(new URL("./rubrica.md", import.meta.url), "utf8");
const versaoRubrica = /versão:\s*(\S+)/.exec(rubrica)?.[1] ?? "?";

async function carregar(): Promise<LinhaTrace[]> {
  const url = arg("url");
  if (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`GET ${url}: ${r.status} ${await r.text()}`);
    return lerTraces(await r.text());
  }
  return lerTraces(readFileSync(arg("traces", "traces/sala.jsonl"), "utf8"));
}

// O observado: só contagens tiradas dos traces, cada uma conferível.
function observar(sessoes: Sessao[]): string[] {
  const chamaram = sessoes.filter((s) => s.chamadas.some((c) => c.tool === "buscar_erros"));
  const comVazio = sessoes.filter((s) => s.chamadas.some(ehVazioDeErros));
  const declarado = comVazio.filter((s) => s.vazioDeclarado);
  const listaVazia = sessoes.filter((s) =>
    s.chamadas.some((c) => ehVazioDeErros(c) && c.resultado.itens === 0 && !c.resultado.fontes_nao_lidas?.length),
  );
  const semLeitura = sessoes.filter((s) => s.chamadas.some((c) => ehVazioDeErros(c) && c.resultado.itens === null));
  const pararam = sessoes.filter((s) => s.desfecho === "parou_no_vazio");
  const andamento = sessoes.filter((s) => s.desfecho === "em_andamento");
  const conferiram = sessoes.filter((s) => s.chamadas.some((c) => c.tool === "status_fontes"));
  const fonteFora = conferiram.filter((s) =>
    s.chamadas.some((c) => c.tool === "status_fontes" && c.resultado.fontes_nao_lidas?.includes("logs")),
  );
  const deploys = sessoes.filter((s) => s.desfecho === "outra_explicacao" && s.chamadas.some((c) => c.tool === "listar_deploys"));
  const s = (n: number) => (n === 1 ? "1 sessão" : `${n} sessões`);
  const linhas = [
    `${s(sessoes.length)} na versão ${versao} do servidor`,
    `${comVazio.length} de ${s(chamaram.length)} que chamaram buscar_erros receberam uma resposta sem nenhum erro`,
    `${listaVazia.length} dessas respostas eram lista vazia (erros: []) sem fonte declarada`,
    `${semLeitura.length} dessas respostas eram erros: null com a fonte declarada como não lida`,
    `${declarado.length} de ${comVazio.length} respostas sem erros declararam a fonte não lida (campo fontes)`,
    `${s(pararam.length)} terminaram sem outra chamada depois dessa resposta`,
    `${s(deploys.length)} seguiram para listar_deploys depois dessa resposta`,
  ];
  if (conferiram.length) {
    linhas.push(`status_fontes foi chamada em ${s(conferiram.length)}; em ${fonteFora.length} delas devolveu logs como não ok`);
  }
  if (andamento.length) linhas.push(`${s(andamento.length)} ainda em andamento na leitura`);
  // A telemetria da própria plataforma, que o agente não vê: o avaliador cruza
  // os traces com o estado das fontes no período. Numa plataforma real, isto
  // vem do monitoramento dos backends; no kit, do estado fixo do backend de exemplo.
  const fontes = Object.entries(estadoDasFontes()).map(([f, e]) => `${f} ${e}`).join(", ");
  linhas.push(`estado das fontes na telemetria da plataforma durante as sessões: ${fontes}`);
  return linhas;
}

function formas(sessoes: Sessao[]) {
  const n = new Map<string, number>();
  for (const s of sessoes) n.set(s.sequencia, (n.get(s.sequencia) ?? 0) + 1);
  return [...n.entries()].map(([sequencia, sessoes]) => ({ sequencia, sessoes })).sort((a, b) => b.sessoes - a.sessoes).slice(0, 8);
}

type Rascunho = {
  sinal: "sinal_falso" | "pista_falsa" | "encadeamento_manual" | "bloqueio" | "nenhum";
  titulo: string;
  hipotese: string;
  confirmaria: string;
  como_saber_que_fechou: string[];
  confianca_no_achado: "baixa" | "media" | "alta";
};

async function perguntar(observado: string[], fs: ReturnType<typeof formas>): Promise<Rascunho> {
  const dados = {
    versao_do_servidor: versao,
    tools: tools.map((t) => ({ nome: t.nome, descricao: t.descricao })),
    observado,
    formas_mais_comuns: fs,
  };
  const cliente = new Anthropic();
  // Saída estruturada por json_schema (output_config.format): o modelo responde
  // um JSON nesta forma. O schema não leva restrição numérica nem de tamanho, e
  // todo objeto fecha com additionalProperties: false, que é o que a API aceita.
  const msg = await cliente.messages.create({
    model: modelo,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: rubrica,
    messages: [
      {
        role: "user",
        content: `Avalie as sessões da sala e devolva o rascunho.\n\n<dados_da_sala>\n${JSON.stringify(dados, null, 2)}\n</dados_da_sala>`,
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sinal: { type: "string", enum: ["sinal_falso", "pista_falsa", "encadeamento_manual", "bloqueio", "nenhum"] },
            titulo: { type: "string", description: "uma linha, descrevendo o defeito da plataforma" },
            hipotese: { type: "string", description: "a causa provável, escrita como hipótese" },
            confirmaria: { type: "string", description: "o que no código confirmaria ou derrubaria a hipótese" },
            como_saber_que_fechou: { type: "array", items: { type: "string" } },
            confianca_no_achado: { type: "string", enum: ["baixa", "media", "alta"] },
          },
          required: ["sinal", "titulo", "hipotese", "confirmaria", "como_saber_que_fechou", "confianca_no_achado"],
        },
      },
    },
  });
  if (msg.stop_reason === "refusal") throw new Error("o modelo recusou a avaliação");
  const texto = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  if (!texto) throw new Error(`resposta sem JSON (stop_reason=${msg.stop_reason})`);
  return JSON.parse(texto) as Rascunho;
}

function markdown(r: Rascunho | null, observado: string[], total: number): string {
  const titulo = r ? (r.sinal === "nenhum" ? "nenhum achado" : `${r.sinal}: ${r.titulo}`) : "(modo seco: sem chamada ao modelo)";
  const partes = [
    `## [reflection] ${titulo}`,
    "",
    "### Observado (verificável nos traces)",
    ...observado.map((o) => `- ${o}`),
  ];
  if (r && r.sinal !== "nenhum") {
    partes.push(
      "",
      "> A causa abaixo é hipótese do avaliador. Confira o mecanismo no código antes de implementar.",
      "",
      "### Hipótese (a confirmar no código)",
      r.hipotese,
      "",
      `**O que confirmaria ou derrubaria:** ${r.confirmaria}`,
      "",
      "### Como saber que fechou",
      ...r.como_saber_que_fechou.map((c) => `- [ ] ${c}`),
    );
  }
  partes.push(
    "",
    `<sub>avaliador: ${r ? modelo : "modo seco"} · rubrica ${versaoRubrica} · ${total} sessões · servidor ${versao}` +
      (r ? ` · confiança no achado: ${r.confianca_no_achado}` : "") +
      "</sub>",
  );
  return partes.join("\n") + "\n";
}

const sessoes = agrupar(await carregar()).filter((s) => s.versao === versao);
if (sessoes.length === 0) {
  console.error(`nenhuma sessão na versão ${versao}: nada para avaliar`);
  process.exit(1);
}
const observado = observar(sessoes);
const rascunho = seco ? null : await perguntar(observado, formas(sessoes));
const texto = markdown(rascunho, observado, sessoes.length);
mkdirSync(new URL("./saida/", import.meta.url), { recursive: true });
const destino = new URL(`./saida/rascunho-${versao}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`, import.meta.url);
writeFileSync(destino, texto);
console.log(texto);
console.error(`gravado em ${destino.pathname}`);
