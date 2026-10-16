import { estadoDasFontes } from "../backend.ts";
import type { Tool } from "./tipos.ts";

export const statusFontes: Tool = {
  nome: "status_fontes",
  descricao: "Mostra o estado das fontes de dados da plataforma: logs, deploys e catálogo de serviços.",
  entrada: {},
  async executar() {
    return { fontes: estadoDasFontes() };
  },
};
