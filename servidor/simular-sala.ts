// Simula uma sala de agentes contra o servidor, para ensaiar o painel e o avaliador.
//
//   node servidor/simular-sala.ts [--url http://127.0.0.1:3000/mcp] [--sessoes 12]
//
// Cada sessão segue uma de três formas, as mesmas que o painel distingue: pára na
// lista vazia, confere a fonte, ou procura outra explicação nos deploys.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const arg = (nome: string, padrao: string) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};
const url = new URL(arg("url", "http://127.0.0.1:3000/mcp"));
const total = Number(arg("sessoes", "12"));

type Passo = { tool: string; args?: Record<string, unknown> };
const formas: { nome: string; peso: number; passos: Passo[] }[] = [
  { nome: "parou", peso: 6, passos: [{ tool: "buscar_erros", args: { servico: "pagamentos", janela_min: 60 } }] },
  {
    nome: "conferiu",
    peso: 2,
    passos: [{ tool: "buscar_erros", args: { servico: "pagamentos", janela_min: 60 } }, { tool: "status_fontes" }],
  },
  {
    nome: "outra",
    peso: 3,
    passos: [
      { tool: "listar_servicos" },
      { tool: "buscar_erros", args: { servico: "pagamentos", janela_min: 60 } },
      { tool: "listar_deploys", args: { servico: "pagamentos", janela_h: 2 } },
    ],
  },
];

function sorteia() {
  const soma = formas.reduce((s, f) => s + f.peso, 0);
  let r = Math.random() * soma;
  for (const f of formas) {
    if ((r -= f.peso) < 0) return f;
  }
  return formas[0];
}

const contagem = new Map<string, number>();
for (let i = 0; i < total; i++) {
  const forma = sorteia();
  const cliente = new Client({ name: `simulador-${i}`, version: "1.0.0" });
  const transporte = new StreamableHTTPClientTransport(url);
  await cliente.connect(transporte);
  const { tools } = await cliente.listTools();
  const anunciadas = new Set(tools.map((t) => t.name));
  if (!anunciadas.has("buscar_erros")) throw new Error("o servidor não anunciou buscar_erros");
  for (const p of forma.passos.filter((p) => anunciadas.has(p.tool))) {
    await cliente.callTool({ name: p.tool, arguments: p.args ?? {} });
  }
  await transporte.terminateSession();
  await cliente.close();
  contagem.set(forma.nome, (contagem.get(forma.nome) ?? 0) + 1);
}
console.log(`${total} sessões simuladas:`, Object.fromEntries(contagem));
