import { z } from "zod";
import { listarDeploys as lerDeploys } from "../backend.ts";
import { semFonte } from "../fontes.ts";
import type { Tool } from "./tipos.ts";

export const listarDeploys: Tool = {
  nome: "listar_deploys",
  descricao: "Lista os deploys recentes, de um serviço ou de todos, numa janela de horas.",
  entrada: {
    servico: z.string().optional().describe("nome do serviço, como em listar_servicos; vazio lista todos"),
    janela_h: z.number().int().min(1).max(168).default(24).describe("janela em horas"),
  },
  async executar(args) {
    try {
      return { deploys: await lerDeploys(args.servico as string | undefined, args.janela_h as number) };
    } catch (erro) {
      return { deploys: null, ...semFonte("deploys", erro) };
    }
  },
};
