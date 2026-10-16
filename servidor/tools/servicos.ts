import { servicos } from "../backend.ts";
import type { Tool } from "./tipos.ts";

export const listarServicos: Tool = {
  nome: "listar_servicos",
  descricao: "Lista os serviços da plataforma, com o time responsável e a linguagem.",
  entrada: {},
  async executar() {
    return { servicos };
  },
};
