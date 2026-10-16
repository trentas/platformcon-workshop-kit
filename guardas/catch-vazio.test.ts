import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { varrer, verificarFonte } from "./catch-vazio.ts";

test("a varredura leu arquivos", () => {
  const r = varrer("servidor/tools");
  expect(r.arquivos).toBeGreaterThan(0);
  expect(r.violacoes).toEqual([]);
});

// A guarda da guarda tem duas metades: ler arquivos e saber reconhecer o
// padrão proibido. Sem a segunda, a regra passaria por vacuidade.
test("a regra reconhece o catch que devolve lista vazia", () => {
  const r = verificarFonte(readFileSync("guardas/exemplos/ruim.ts", "utf8"), "guardas/exemplos/ruim.ts");
  expect(r.violacoes).toHaveLength(1);
  expect(r.violacoes[0]).toMatchObject({ linha: 8, tool: "ruim" });
});

test("comentário com o padrão não dispara a regra", () => {
  const fonte = ["async function f() {", "  try { return 1 }", "  // catch { return [] }", "  catch (e) { return { itens: null, ...semFonte('x', e) } }", "}"].join("\n");
  expect(verificarFonte(fonte, "f.ts").violacoes).toEqual([]);
});

test("a exceção declarada no código é aceita e aparece no relatório", () => {
  const r = varrer("servidor/tools");
  expect(r.excecoes.map((e) => e.arquivo)).toContain("servidor/tools/erros.ts");
});
