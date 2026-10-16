// O gravador de trace: uma linha por chamada de tool, com a FORMA da chamada.
//
// Grava o nome da tool, os argumentos estruturados, o status, a quantidade de
// itens devolvidos, as fontes que a resposta declarou não ter lido, a ordem e a
// duração. Não grava o conteúdo da resposta, e argumento de texto livre vira
// tamanho e hash. O prompt e a resposta do agente nunca chegam ao servidor.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Versao } from "./tools/tipos.ts";

export type Resultado = { status: "ok" | "erro"; itens: number | null; fontes_nao_lidas?: string[] };

export type LinhaTrace = {
  t: string;
  sessao: string;
  seq: number;
  versao: Versao;
  tool: string;
  args: Record<string, unknown>;
  resultado: Resultado;
  duracao_ms: number;
};

const hash = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);

// O id da sessão MCP é um UUID; no trace entra só um prefixo do hash dele.
export const idDeSessao = (mcpSessionId: string) => "s-" + hash(mcpSessionId, 6);

// Texto livre (marcado na tool) vira tamanho e hash. Fora da marcação, texto
// longo ou com quebra de linha também: é a rede para o parâmetro que ninguém
// marcou.
export function formaDosArgs(args: Record<string, unknown>, textoLivre: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && (textoLivre.includes(k) || v.length > 64 || v.includes("\n"))) {
      out[k] = { tamanho: v.length, hash: hash(v, 8) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Resume a resposta sem copiar o conteúdo: quantos itens a lista principal tem
// e quais fontes a resposta disse que não leu. Guarda o NOME da fonte, que é da
// plataforma, nunca o texto do aviso.
export function resumoDoResultado(res: Record<string, unknown>): Resultado {
  let itens: number | null = null;
  for (const v of Object.values(res)) {
    if (Array.isArray(v)) {
      itens = v.length;
      break;
    }
  }
  const fontes = res.fontes;
  let naoLidas: string[] | undefined;
  if (fontes && typeof fontes === "object" && !Array.isArray(fontes)) {
    const entradas = Object.entries(fontes as Record<string, unknown>);
    if (itens === null) itens = entradas.length;
    naoLidas = entradas.filter(([, estado]) => estado !== "ok").map(([nome]) => nome);
  }
  return naoLidas && naoLidas.length > 0 ? { status: "ok", itens, fontes_nao_lidas: naoLidas } : { status: "ok", itens };
}

export class Gravador {
  private arquivo: string;
  private todas: LinhaTrace[] = [];
  private seqPorSessao = new Map<string, number>();

  constructor(arquivo: string) {
    this.arquivo = arquivo;
    mkdirSync(dirname(arquivo), { recursive: true });
    if (existsSync(arquivo)) {
      for (const l of readFileSync(arquivo, "utf8").split("\n")) {
        if (!l.trim()) continue;
        const linha = JSON.parse(l) as LinhaTrace;
        this.todas.push(linha);
        this.seqPorSessao.set(linha.sessao, Math.max(this.seqPorSessao.get(linha.sessao) ?? 0, linha.seq));
      }
    }
  }

  grava(e: { mcpSessionId: string; versao: Versao; tool: string; args: Record<string, unknown>; textoLivre?: string[]; resultado: Resultado; duracaoMs: number }): LinhaTrace {
    const sessao = idDeSessao(e.mcpSessionId);
    const seq = (this.seqPorSessao.get(sessao) ?? 0) + 1;
    this.seqPorSessao.set(sessao, seq);
    const linha: LinhaTrace = {
      t: new Date().toISOString(),
      sessao,
      seq,
      versao: e.versao,
      tool: e.tool,
      args: formaDosArgs(e.args, e.textoLivre),
      resultado: e.resultado,
      duracao_ms: Math.round(e.duracaoMs),
    };
    this.todas.push(linha);
    appendFileSync(this.arquivo, JSON.stringify(linha) + "\n");
    return linha;
  }

  linhas(): LinhaTrace[] {
    return this.todas;
  }

  jsonl(): string {
    return this.todas.map((l) => JSON.stringify(l)).join("\n") + (this.todas.length ? "\n" : "");
  }
}

export function lerTraces(texto: string): LinhaTrace[] {
  return texto
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LinhaTrace);
}
