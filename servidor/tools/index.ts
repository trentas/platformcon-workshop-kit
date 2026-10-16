import { listarDeploys } from "./deploys.ts";
import { buscarErros } from "./erros.ts";
import { statusFontes } from "./fontes.ts";
import { listarServicos } from "./servicos.ts";
import type { Tool } from "./tipos.ts";

export const tools: Tool[] = [listarServicos, listarDeploys, buscarErros, statusFontes];
