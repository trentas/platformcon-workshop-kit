// Agrupa as linhas de trace em sessões e classifica a forma de cada uma.
// Usado pelo painel e pelo avaliador, para que os dois contem do mesmo jeito.

import type { LinhaTrace } from "./trace.ts";
import type { Versao } from "./tools/tipos.ts";

// O que aconteceu depois que buscar_erros respondeu sem nenhum erro: lista vazia
// (v1, que não diz se leu) ou null com a fonte declarada (v2, que diz que não leu).
export type Desfecho =
  | "parou_no_vazio" //        a sessão terminou logo depois do vazio
  | "conferiu_a_fonte" //      chamou status_fontes
  | "outra_explicacao" //      seguiu com outras tools, sem conferir a fonte
  | "em_andamento" //          ainda pode chamar outra tool
  | "sem_vazio"; //            não recebeu lista vazia de buscar_erros

export type Sessao = {
  id: string;
  versao: Versao;
  chamadas: LinhaTrace[];
  encerrada: boolean;
  sequencia: string;
  desfecho: Desfecho;
  // a resposta sem erros declarou a fonte não lida (v2) ou não declarou nada (v1)
  vazioDeclarado: boolean | null;
};

// Sem chamada nova por este tempo, a sessão conta como encerrada.
export const INATIVIDADE_MS = 30_000;

// A sessão é a conexão MCP dentro de uma versão do servidor. Um chat novo no
// mesmo agente pode reaproveitar a conexão; sem separar por versão, a pergunta
// feita depois da troca entraria como continuação da sessão da v1 e sumiria da
// coluna da v2. Cada lado conta como uma sessão.
export function agrupar(linhas: LinhaTrace[], agora = Date.now(), inatividadeMs = INATIVIDADE_MS): Sessao[] {
  const porId = new Map<string, LinhaTrace[]>();
  for (const l of linhas) {
    const id = `${l.sessao}/${l.versao}`;
    const lista = porId.get(id) ?? [];
    lista.push(l);
    porId.set(id, lista);
  }
  const out: Sessao[] = [];
  for (const [id, chamadas] of porId) {
    chamadas.sort((a, b) => a.seq - b.seq);
    const ultima = Date.parse(chamadas[chamadas.length - 1].t);
    const encerrada = agora - ultima > inatividadeMs;
    const vazio = chamadas.find((c) => ehVazioDeErros(c));
    out.push({
      id,
      versao: chamadas[0].versao,
      chamadas,
      encerrada,
      sequencia: sequencia(chamadas, encerrada),
      desfecho: desfecho(chamadas, encerrada),
      vazioDeclarado: vazio ? (vazio.resultado.fontes_nao_lidas?.length ?? 0) > 0 : null,
    });
  }
  return out;
}

// buscar_erros respondeu sem erro nenhum: 0 itens, ou nenhum item porque a fonte não foi lida.
export function ehVazioDeErros(c: LinhaTrace): boolean {
  return c.tool === "buscar_erros" && c.resultado.status === "ok" && (c.resultado.itens === 0 || c.resultado.itens === null);
}

function desfecho(chamadas: LinhaTrace[], encerrada: boolean): Desfecho {
  const i = chamadas.findIndex(ehVazioDeErros);
  if (i < 0) return "sem_vazio";
  if (chamadas.some((c) => c.tool === "status_fontes")) return "conferiu_a_fonte";
  if (i < chamadas.length - 1) return "outra_explicacao";
  return encerrada ? "parou_no_vazio" : "em_andamento";
}

// "listar_servicos → buscar_erros → fim"; chamadas repetidas em sequência viram "×N".
export function sequencia(chamadas: LinhaTrace[], encerrada: boolean): string {
  const partes: string[] = [];
  let anterior = "";
  let repeticoes = 0;
  const fecha = () => {
    if (anterior) partes.push(repeticoes > 1 ? `${anterior} ×${repeticoes}` : anterior);
  };
  for (const c of chamadas) {
    if (c.tool === anterior) {
      repeticoes++;
      continue;
    }
    fecha();
    anterior = c.tool;
    repeticoes = 1;
  }
  fecha();
  const corpo = partes.length > 6 ? [...partes.slice(0, 6), "…"] : partes;
  return [...corpo, encerrada ? "fim" : "…"].join(" → ");
}
