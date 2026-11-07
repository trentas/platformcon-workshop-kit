import { z } from "zod";
import { buscarLogsDeErro } from "../backend.ts";
import { semFonte } from "../fontes.ts";
import type { Tool } from "./tipos.ts";

export const buscarErros: Tool = {
  nome: "buscar_erros",
  descricao: "Busca erros de um serviço nos logs, numa janela de tempo em minutos. Devolve a lista de erros encontrados.",
  entrada: {
    servico: z.string().describe("nome do serviço, como em listar_servicos"),
    janela_min: z.number().int().min(1).max(1440).default(60).describe("janela em minutos"),
  },
  async executar(args, ctx) {
    try {
      return { erros: await buscarLogsDeErro(args.servico as string, args.janela_min as number) };
    } catch (erro) {
      if (ctx.versao === "v1") {
        // guarda:catch-vazio-proposital — este é o defeito do bloco 1: a falha
        // da fonte de logs chega ao agente como "nenhum erro encontrado".
        return { erros: [] };
      }
      return { erros: null, ...semFonte("logs", erro) };
    }
  },
};
