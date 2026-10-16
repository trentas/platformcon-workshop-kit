import type { z } from "zod";

export type Versao = "v1" | "v2";

export type Contexto = { versao: Versao };

export type Tool = {
  nome: string;
  descricao: string;
  entrada: Record<string, z.ZodType>;
  // parâmetros de texto livre: no trace viram tamanho e hash, nunca o texto
  textoLivre?: string[];
  executar: (args: Record<string, unknown>, ctx: Contexto) => Promise<Record<string, unknown>>;
};
