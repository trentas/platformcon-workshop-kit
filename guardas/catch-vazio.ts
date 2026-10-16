// Verificação de CI da estação 2: um catch dentro de uma tool não pode devolver
// coleção vazia sem declarar a fonte que falhou.
//
// A regra é estreita de propósito. Ela procura, no fonte sem comentários, todo
// bloco catch que tenha um return com "[]" e sem semFonte(...) ou campo
// "fontes". Exceção é declarada no código, com o comentário
// "guarda:catch-vazio-proposital" no bloco, e aparece no relatório.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const MARCA_DE_EXCECAO = "guarda:catch-vazio-proposital";

export type Ocorrencia = { arquivo: string; linha: number; tool: string };
export type Resultado = { arquivos: number; violacoes: Ocorrencia[]; excecoes: Ocorrencia[] };

export function varrer(dir: string): Resultado {
  const out: Resultado = { arquivos: 0, violacoes: [], excecoes: [] };
  let entradas: string[];
  try {
    entradas = readdirSync(dir);
  } catch {
    // pasta que não existe é zero arquivos lidos, e o relatório diz isso
    return out;
  }
  for (const nome of entradas.sort()) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      const sub = varrer(caminho);
      out.arquivos += sub.arquivos;
      out.violacoes.push(...sub.violacoes);
      out.excecoes.push(...sub.excecoes);
      continue;
    }
    if (!nome.endsWith(".ts") || nome.endsWith(".test.ts") || nome.endsWith(".d.ts")) continue;
    out.arquivos++;
    const r = verificarFonte(readFileSync(caminho, "utf8"), relative(process.cwd(), caminho));
    out.violacoes.push(...r.violacoes);
    out.excecoes.push(...r.excecoes);
  }
  return out;
}

export function verificarFonte(texto: string, arquivo: string): Omit<Resultado, "arquivos"> {
  const codigo = semComentarios(texto);
  const linhasOriginais = texto.split("\n");
  const tool = basename(arquivo).replace(/\.ts$/, "");
  const out: Omit<Resultado, "arquivos"> = { violacoes: [], excecoes: [] };

  const abertura = /\bcatch\b\s*(\([^)]*\))?\s*\{/g;
  for (let m = abertura.exec(codigo); m; m = abertura.exec(codigo)) {
    const inicio = m.index + m[0].length;
    const fim = fechamento(codigo, inicio);
    const corpo = codigo.slice(inicio, fim);
    const retorno = /\breturn\b([^;]*)/g;
    for (let r = retorno.exec(corpo); r; r = retorno.exec(corpo)) {
      const expr = r[1];
      if (!expr.includes("[]") || /\bsemFonte\s*\(/.test(expr) || /\bfontes\b/.test(expr)) continue;
      const linha = linhaDe(codigo, inicio + r.index);
      const linhaCatch = linhaDe(codigo, m.index);
      const linhaFim = linhaDe(codigo, fim);
      const declarada = linhasOriginais.slice(Math.max(0, linhaCatch - 2), linhaFim).some((l) => l.includes(MARCA_DE_EXCECAO));
      (declarada ? out.excecoes : out.violacoes).push({ arquivo, linha, tool });
    }
  }
  return out;
}

// Troca comentários por espaços, mantendo quebras de linha e posições, e sem
// tocar no que está dentro de strings.
export function semComentarios(texto: string): string {
  let out = "";
  let i = 0;
  let aspas: string | null = null;
  while (i < texto.length) {
    const c = texto[i];
    const d = texto[i + 1];
    if (aspas) {
      out += c;
      if (c === "\\") {
        out += d ?? "";
        i += 2;
        continue;
      }
      if (c === aspas) aspas = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      aspas = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < texto.length && texto[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      while (i < texto.length && !(texto[i] === "*" && texto[i + 1] === "/")) {
        out += texto[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Posição da chave que fecha o bloco aberto antes de `inicio`, ignorando strings.
function fechamento(codigo: string, inicio: number): number {
  let prof = 1;
  let aspas: string | null = null;
  for (let i = inicio; i < codigo.length; i++) {
    const c = codigo[i];
    if (aspas) {
      if (c === "\\") i++;
      else if (c === aspas) aspas = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") aspas = c;
    else if (c === "{") prof++;
    else if (c === "}" && --prof === 0) return i;
  }
  return codigo.length;
}

function linhaDe(texto: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos; i++) if (texto[i] === "\n") n++;
  return n;
}
