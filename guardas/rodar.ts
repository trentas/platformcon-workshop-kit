// O que o CI roda: a verificação sobre servidor/tools, com a mensagem escrita
// para quem vai corrigir, que muitas vezes é o próprio agente de código.
//
// Duas checagens, nesta ordem: a regra (nenhuma violação) e a guarda da guarda
// (a varredura leu pelo menos um arquivo). Sem a segunda, uma pasta movida de
// lugar faz a regra passar sem ter verificado nada.

import { varrer } from "./catch-vazio.ts";

const dir = process.argv[2] ?? "servidor/tools";
const r = varrer(dir);

console.log("guardas/catch-vazio");
let falhou = false;

for (const v of r.violacoes) {
  falhou = true;
  console.log(`  FALHA ${v.arquivo}:${v.linha}`);
  console.log("  catch devolve [] sem declarar");
  console.log("  a fonte que falhou");
  console.log(`  use: semFonte("${v.tool}", erro)`);
}
if (r.violacoes.length === 0) console.log(`  regra: nenhuma violação em ${dir}`);

if (r.arquivos === 0) {
  falhou = true;
  console.log(`  FALHA nenhum arquivo lido em ${dir}: a varredura não verificou nada`);
} else {
  console.log(`  guarda da guarda: ${r.arquivos} arquivos lidos`);
}

for (const e of r.excecoes) {
  console.log(`  exceção declarada: ${e.arquivo}:${e.linha}`);
}

process.exit(falhou ? 1 : 0);
