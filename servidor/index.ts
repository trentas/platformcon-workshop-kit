// Servidor MCP de exemplo da estação 1 ("plataforma"), com o painel do telão.
//
// Na porta pública (PORT, a que vai para o túnel ou para o proxy):
//   POST/GET/DELETE /mcp     o servidor MCP (Streamable HTTP, uma sessão por agente)
//   POST /admin/versao       troca a versão no ar: {"versao":"v2"}   (Bearer ADMIN_TOKEN)
//   GET  /admin/traces       os traces da sala, em JSONL              (Bearer ADMIN_TOKEN)
//   GET  /saude
//
// Numa porta só local (PAINEL_PORT), o painel do telão:
//   GET  /painel             o painel da sala
//   GET  /painel/dados       os números do painel, em JSON
//
// O painel fica fora da porta pública de propósito: ele consulta o servidor a
// cada 2 s, e por um túnel com cota (o ngrok gratuito tem 20 mil requisições por
// mês) meia sala com o painel aberto esgotaria a cota no meio da estação.
//
// Variáveis: PORT (3000), HOST (127.0.0.1), ALLOWED_HOSTS (lista separada por
// vírgula, com o domínio público; os nomes locais seguem aceitos), PAINEL_PORT
// (3001), PAINEL_HOST (127.0.0.1), VERSAO (v1), TRACES (traces/sala.jsonl),
// ADMIN_TOKEN (sem ele, as rotas de admin respondem 503).

import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools/index.ts";
import type { Versao } from "./tools/tipos.ts";
import { Gravador, resumoDoResultado } from "./trace.ts";
import { dadosDoPainel, paginaPainel } from "./painel.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const LOCAIS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const publicos = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
// Com um domínio público configurado, o acesso local continua valendo (o túnel
// chega por localhost, e quem roda o servidor testa por ele).
const ALLOWED_HOSTS = publicos?.length ? [...publicos, ...LOCAIS] : undefined;
const PAINEL_PORT = Number(process.env.PAINEL_PORT ?? 3001);
const PAINEL_HOST = process.env.PAINEL_HOST ?? "127.0.0.1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const MAX_SESSOES = 500;
const SESSAO_OCIOSA_MS = 30 * 60_000;

const estado: { versao: Versao } = { versao: process.env.VERSAO === "v2" ? "v2" : "v1" };
// Tools que o servidor não anuncia (ex.: TOOLS_OCULTAS=status_fontes): sem como
// conferir a fonte, o agente só tem a resposta de buscar_erros para decidir.
const OCULTAS = new Set((process.env.TOOLS_OCULTAS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const gravador = new Gravador(process.env.TRACES ?? "traces/sala.jsonl");

function criarServidor(): McpServer {
  const servidor = new McpServer({ name: "plataforma", version: "1.0.0" });
  for (const t of tools.filter((t) => !OCULTAS.has(t.nome))) {
    servidor.registerTool(t.nome, { description: t.descricao, inputSchema: t.entrada }, async (...p: unknown[]) => {
      const [args, extra] = (p.length >= 2 ? p : [{}, p[0]]) as [Record<string, unknown>, { sessionId?: string }];
      const versao = estado.versao;
      const inicio = performance.now();
      const base = { mcpSessionId: extra?.sessionId ?? "sem-sessao", versao, tool: t.nome, args, textoLivre: t.textoLivre };
      try {
        const res = await t.executar(args, { versao });
        gravador.grava({ ...base, resultado: resumoDoResultado(res), duracaoMs: performance.now() - inicio });
        return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
      } catch (erro) {
        gravador.grava({ ...base, resultado: { status: "erro", itens: null }, duracaoMs: performance.now() - inicio });
        console.error(`erro em ${t.nome}:`, erro);
        return { isError: true, content: [{ type: "text" as const, text: "erro interno do servidor de exemplo" }] };
      }
    });
  }
  return servidor;
}

const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS });
const sessoes = new Map<string, { transporte: StreamableHTTPServerTransport; ultimaAtividade: number }>();

app.post("/mcp", async (req: Request, res: Response) => {
  const id = req.header("mcp-session-id");
  const existente = id ? sessoes.get(id) : undefined;
  if (existente) {
    existente.ultimaAtividade = Date.now();
    await existente.transporte.handleRequest(req, res, req.body);
    return;
  }
  if (id || !isInitializeRequest(req.body)) {
    res.status(id ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32000, message: "sessão desconhecida: reconecte o agente" }, id: null });
    return;
  }
  if (sessoes.size >= MAX_SESSOES) {
    res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "servidor cheio" }, id: null });
    return;
  }
  const transporte = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessoes.set(sid, { transporte, ultimaAtividade: Date.now() });
    },
  });
  transporte.onclose = () => {
    if (transporte.sessionId) sessoes.delete(transporte.sessionId);
  };
  await criarServidor().connect(transporte);
  await transporte.handleRequest(req, res, req.body);
});

const porSessao = async (req: Request, res: Response) => {
  const id = req.header("mcp-session-id");
  const s = id ? sessoes.get(id) : undefined;
  if (!s) {
    res.status(id ? 404 : 400).send("sessão desconhecida");
    return;
  }
  s.ultimaAtividade = Date.now();
  await s.transporte.handleRequest(req, res);
};
app.get("/mcp", porSessao);
app.delete("/mcp", porSessao);

function admin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_TOKEN) {
    res.status(503).send("ADMIN_TOKEN não configurado");
    return;
  }
  const recebido = Buffer.from(req.header("authorization")?.replace(/^Bearer /, "") ?? "");
  const esperado = Buffer.from(ADMIN_TOKEN);
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) {
    res.status(401).send("token inválido");
    return;
  }
  next();
}

app.post("/admin/versao", admin, (req: Request, res: Response) => {
  const v = req.body?.versao;
  if (v !== "v1" && v !== "v2") {
    res.status(400).json({ erro: 'use {"versao":"v1"} ou {"versao":"v2"}' });
    return;
  }
  estado.versao = v;
  console.log(`versão no ar: ${v}`);
  res.json(estado);
});
app.get("/admin/traces", admin, (_req: Request, res: Response) => {
  res.type("application/x-ndjson").send(gravador.jsonl());
});
app.get("/saude", (_req: Request, res: Response) => {
  res.json({ ok: true, versao: estado.versao, sessoes: sessoes.size, chamadas: gravador.linhas().length });
});

// Fecha sessões ociosas: um agente que sumiu não segura memória para sempre.
setInterval(() => {
  const limite = Date.now() - SESSAO_OCIOSA_MS;
  for (const [id, s] of sessoes) {
    if (s.ultimaAtividade < limite) {
      void s.transporte.close();
      sessoes.delete(id);
    }
  }
}, 60_000).unref();

const painel = express();
painel.get("/", (_req: Request, res: Response) => res.redirect("/painel"));
painel.get("/painel", (_req: Request, res: Response) => {
  res.type("html").send(paginaPainel());
});
painel.get("/painel/dados", (_req: Request, res: Response) => {
  res.json(dadosDoPainel(gravador.linhas(), estado.versao));
});

app.listen(PORT, HOST, () => {
  console.log(`plataforma (${estado.versao}) em http://${HOST}:${PORT}/mcp`);
  if (publicos?.length) console.log(`hosts públicos aceitos: ${publicos.join(", ")}`);
  if (!ADMIN_TOKEN) console.log("sem ADMIN_TOKEN: as rotas de admin estão desligadas");
});
painel.listen(PAINEL_PORT, PAINEL_HOST, () => {
  console.log(`painel em http://${PAINEL_HOST}:${PAINEL_PORT}/painel (só local)`);
});
