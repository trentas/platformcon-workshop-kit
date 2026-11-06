import { expect, test } from "vitest";
import { agrupar } from "./sessoes.ts";
import type { LinhaTrace } from "./trace.ts";
import type { Versao } from "./tools/tipos.ts";

const t0 = Date.parse("2026-11-07T10:00:00Z");

function linha(sessao: string, seq: number, versao: Versao, tool: string, segundos: number, itens: number | null = 0): LinhaTrace {
  return {
    t: new Date(t0 + segundos * 1000).toISOString(),
    sessao,
    seq,
    versao,
    tool,
    args: {},
    resultado: { status: "ok", itens, ...(versao === "v2" && tool === "buscar_erros" ? { fontes_nao_lidas: ["logs"] } : {}) },
    duracao_ms: 40,
  };
}

// Um agente que abre um chat novo sem reconectar faz as duas perguntas na mesma
// conexão MCP. A pergunta depois da troca de versão precisa aparecer na v2.
test("a mesma conexão MCP, antes e depois da troca de versão, conta como uma sessão em cada versão", () => {
  const linhas = [linha("s-abc123", 1, "v1", "buscar_erros", 0), linha("s-abc123", 2, "v2", "buscar_erros", 120, null)];
  const sessoes = agrupar(linhas, t0 + 300_000);
  expect(sessoes).toHaveLength(2);
  const [v1, v2] = ["v1", "v2"].map((v) => sessoes.find((s) => s.versao === v));
  expect(v1).toMatchObject({ desfecho: "parou_no_vazio", vazioDeclarado: false, sequencia: "buscar_erros → fim" });
  expect(v2).toMatchObject({ desfecho: "parou_no_vazio", vazioDeclarado: true, sequencia: "buscar_erros → fim" });
});

test("sessões diferentes na mesma versão continuam separadas, e a mesma sessão continua junta", () => {
  const linhas = [
    linha("s-aaa111", 1, "v1", "listar_servicos", 0, 4),
    linha("s-bbb222", 1, "v1", "buscar_erros", 1),
    linha("s-aaa111", 2, "v1", "buscar_erros", 2),
    linha("s-aaa111", 3, "v1", "listar_deploys", 3, 1),
  ];
  const sessoes = agrupar(linhas, t0 + 300_000);
  expect(sessoes).toHaveLength(2);
  expect(sessoes.map((s) => s.sequencia).sort()).toEqual(["buscar_erros → fim", "listar_servicos → buscar_erros → listar_deploys → fim"]);
});
