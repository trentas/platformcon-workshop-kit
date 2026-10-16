// Como uma tool diz que uma fonte não foi lida.
//
// A regra do kit: quando a fonte de uma tool falha, a coleção que ela leria vem
// como null, nunca como lista vazia, e a resposta declara qual fonte não foi
// lida e por quê. Lista vazia quer dizer "li e não havia nada"; null com a fonte
// declarada quer dizer "não li". Sem essa diferença, a falha e a ausência chegam
// ao agente com a mesma forma. A verificação de CI da estação 2 cobra o uso deste
// helper em todo catch de tool.
//
//   return { erros: null, ...semFonte("logs", erro) };

export type FontesNaoLidas = { fontes: Record<string, string>; aviso: string };

export function semFonte(fonte: string, erro: unknown): FontesNaoLidas {
  const motivo = erro instanceof Error ? erro.message : String(erro);
  return { fontes: { [fonte]: "indisponivel" }, aviso: `${fonte} não lidos: ${motivo}` };
}
