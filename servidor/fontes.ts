// Como uma tool diz que uma fonte não foi lida.
//
// A regra do kit: quando a fonte de uma tool falha, a resposta continua com o
// mesmo formato (a lista vazia, se for o caso), mas declara qual fonte não foi
// lida e por quê. Sem isso, "a fonte caiu" e "não há nada" chegam ao agente com
// a mesma forma. A verificação de CI da estação 2 cobra o uso deste helper.

export type FontesNaoLidas = { fontes: Record<string, string>; aviso: string };

export function semFonte<T extends object>(fonte: string, erro: unknown, corpo: T): T & FontesNaoLidas {
  const motivo = erro instanceof Error ? erro.message : String(erro);
  return { ...corpo, fontes: { [fonte]: "indisponivel" }, aviso: `${fonte} não lidos: ${motivo}` };
}
