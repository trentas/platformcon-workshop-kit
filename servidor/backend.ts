// O "backend" da plataforma de exemplo: dados fixos de uma empresa fictícia.
//
// A fonte de logs está fora do ar desde o início, de propósito. É o defeito que
// a estação 1 descobre: na v1, buscar_erros transforma essa falha em lista vazia.

export class FonteIndisponivel extends Error {
  fonte: string;
  constructor(fonte: string, motivo: string) {
    super(motivo);
    this.name = "FonteIndisponivel";
    this.fonte = fonte;
  }
}

// Latência simulada de um backend de verdade, para o trace não mostrar 0 ms.
const espera = () => new Promise((r) => setTimeout(r, 20 + Math.random() * 40));

export type Servico = { nome: string; time: string; linguagem: string };

export const servicos: Servico[] = [
  { nome: "pagamentos", time: "financeiro", linguagem: "go" },
  { nome: "checkout", time: "loja", linguagem: "typescript" },
  { nome: "catalogo", time: "loja", linguagem: "java" },
  { nome: "estoque", time: "logistica", linguagem: "go" },
];

export type Deploy = { servico: string; versao: string; quando: string; ha_min: number; autor: string; status: string };

// Os deploys são relativos a "agora": o de pagamentos aconteceu há 40 minutos,
// dentro da janela da pergunta, para que um agente possa se perguntar se ele
// tem relação com os erros.
const historico = [
  { servico: "pagamentos", versao: "2.14.0", haMin: 40, autor: "ci", status: "concluido" },
  { servico: "checkout", versao: "5.2.1", haMin: 5 * 60, autor: "ci", status: "concluido" },
  { servico: "catalogo", versao: "1.9.3", haMin: 26 * 60, autor: "ci", status: "concluido" },
  { servico: "estoque", versao: "3.0.0", haMin: 3 * 24 * 60, autor: "ci", status: "concluido" },
];

export async function listarDeploys(servico: string | undefined, janelaH: number): Promise<Deploy[]> {
  await espera();
  const agora = Date.now();
  return historico
    .filter((d) => (!servico || d.servico === servico) && d.haMin <= janelaH * 60)
    .map((d) => ({
      servico: d.servico,
      versao: d.versao,
      quando: new Date(agora - d.haMin * 60_000).toISOString(),
      ha_min: d.haMin,
      autor: d.autor,
      status: d.status,
    }));
}

export async function buscarLogsDeErro(_servico: string, _janelaMin: number): Promise<unknown[]> {
  await espera();
  throw new FonteIndisponivel("logs", "timeout de 5 s ao consultar o backend de logs");
}

export function estadoDasFontes(): Record<string, string> {
  return { logs: "indisponivel", deploys: "ok", servicos: "ok" };
}
