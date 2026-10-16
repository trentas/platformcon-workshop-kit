# Quando o usuário da plataforma é um agente

Kit do workshop da **PlatformCon São Paulo, 07/11/2026**. Do trace de uso à verificação no kernel, com MCP, CI e eBPF.

São três estações:

| Estação | O que se faz | Onde roda |
|---|---|---|
| 1. Agentes como usuários de um servidor MCP | O seu agente consulta um servidor de exemplo; os traces da sala viram rascunho de issue | No seu agente, contra um servidor nosso |
| 2. Verificações de CI para código escrito por agentes | Demonstração | Telão |
| 3. Comparação de versões com eBPF (ptop) | Captura de duas versões de um serviço e comparação contra o ruído | Na sua máquina Linux ou VM |

> **Estado do kit:** as três estações estão escritas. A estação 3 foi testada de ponta a ponta (arm64, kernel 7.0); a 1 e a 2, com sessões simuladas, e o avaliador contra o modelo (v1: sinal falso; v2: nenhum achado). Falta testar a estação 1 com agentes de verdade.

## Antes do workshop: o preflight

Você precisa de:

- Linux nativo ou uma VM Linux (no Mac com Apple Silicon: UTM, Parallels, Lima ou OrbStack);
- kernel 5.8 ou mais novo, com BTF (`/sys/kernel/btf/vmlinux`), em amd64 ou arm64;
- `sudo`, uma vez, para aplicar as capabilities no ptop;
- Go 1.25 ou mais novo, para compilar as ferramentas do kit;
- um agente de IA compatível com MCP (Claude Code, Cursor, VS Code, Gemini CLI, Codex…), para a estação 1.

Clone o kit **no disco da própria máquina ou VM** (não numa pasta compartilhada com o host: o `setcap` precisa de atributos estendidos que essas pastas costumam não ter) e rode:

```bash
make preflight
```

O preflight confere a máquina, baixa o [ptop](https://github.com/trentas/ptop) da release (conferindo o `SHA256SUMS`), aplica as capabilities, compila as ferramentas e faz uma captura de teste de 5 segundos. No fim ele imprime uma linha para colar no formulário do workshop.

### Sobre as capabilities

O preflight roda:

```bash
sudo setcap cap_bpf,cap_perfmon,cap_sys_admin,cap_dac_read_search,cap_sys_ptrace+ep ./bin/ptop
```

`cap_sys_admin` é quase root na prática. Conceda numa VM de laboratório, ou rode sem ela e use `./bin/ptop --caps` para ver o que deixou de coletar. O [README do ptop](https://github.com/trentas/ptop) explica o que cada uma libera.

## Estação 3: comparação de versões com eBPF

O serviço tem duas versões. A `api` chama um `estoque` a cada request; a v1 reaproveita conexões (pool), a v2 abre uma conexão nova por request. O estoque simula 10 ms de trabalho.

Use dois terminais na pasta do kit.

```bash
./bin/ptop --caps                      # 1. todos os coletores devem aparecer como "will run"

make v1                                # 2. terminal 1: sobe a v1 com carga constante (50 req/s)
make captura NOME=v1-a                 #    terminal 2: captura 60 s

./bin/assinante unix:///tmp/ptop.sock  # 3. terminal 3, durante uma captura: um leitor sem privilégio

make v2                                # 4. terminal 1 (Ctrl-C antes, para sair do acompanhamento)
make captura NOME=v2
make v1
make captura NOME=v1-b                 #    segunda captura da v1: mede o ruído

make comparar A=v1-a B=v2              # 5. mudança de código, com o ruído ao lado
make comparar A=v1-a B=v1-b            #    o próprio ruído

sudo setcap cap_bpf,cap_perfmon+ep ./bin/ptop   # 6. capabilities incompletas
./bin/ptop --caps
make v1 && make captura NOME=v1-parcial
make comparar A=v1-a B=v1-parcial
make preflight                         #    no fim: restaura o conjunto completo

make parar                             # derruba o serviço e a carga
```

O que cada alvo faz:

- `make v1` / `make v2` sobem o estoque, a api e a carga em segundo plano e acompanham o log da carga (p50, p99, taxa e erros a cada 10 s). Ctrl-C sai do acompanhamento; o serviço continua rodando.
- `make captura NOME=x` roda o ptop por `DURACAO` segundos (padrão 60) sobre a api, com `--serve unix:///tmp/ptop.sock --export`, e guarda em `capturas/x.jsonl` o stream e, em `capturas/x.carga.jsonl`, o log da carga do mesmo período.
- `make comparar A=x B=y` compara as duas capturas por request. Antes dos números, compara o estado de cada coletor nas duas: se a instrumentação difere, a comparação é recusada. Com uma `v1-b` no disco, cada métrica sai com a variação entre `v1-a` e `v1-b` ao lado, e só o que passa dela é marcado.

### Resultado na máquina de teste

arm64, kernel 7.0, ptop 1.9.0, capturas de 30 s:

```
métrica                     v1-a    v2      diferença   ruído
latência p50 (ms)           11,25   11,82   +0,56       0,00    dentro do ruído
latência p99 (ms)           14,36   15,83   +1,47       1,47    dentro do ruído
connect() por request       0,00    1,00    +1,00       0,00    acima do ruído
socket() por request        0,00    1,00    +1,00       0,00    acima do ruído
close() por request         0,00    1,00    +1,00       0,00    acima do ruído
setsockopt() por request    0,00    5,01    +5,00       0,00    acima do ruído
```

Pela latência, a v2 passaria num teste de carga comum. No kernel, cada request passou a abrir e fechar uma conexão.

### Como a comparação conta

- A janela de uma captura vai do primeiro ao último snapshot de syscalls do ptop. Os requests dessa janela vêm do log da carga, interpolado nos dois instantes.
- Uma métrica que não pôde ser medida aparece como `não medido`, nunca como zero.
- Uma diferença é marcada quando passa o dobro da variação entre `v1-a` e `v1-b` e também um piso: 5% (ou 0,02 por request) nas syscalls e 10% na latência, porque o histograma de latência tem resolução de 5%.

## Estação 1: agentes como usuários de um servidor MCP (lado do instrutor)

O servidor de exemplo se chama `plataforma` e tem quatro tools: `listar_servicos`, `listar_deploys`, `buscar_erros` e `status_fontes`. A fonte de logs está fora do ar desde o início. Na v1, `buscar_erros` devolve `{"erros": []}`, como se não houvesse erro; na v2, devolve `{"erros": null, "fontes": {"logs": "indisponivel"}}`. Lista vazia quer dizer "li e não havia nada"; `null` com a fonte declarada quer dizer "não li".

```bash
make servidor                 # MCP em http://127.0.0.1:3000/mcp; painel só local em http://127.0.0.1:3001/painel (ADMIN_TOKEN padrão: dev)
make simular SESSOES=20       # ensaio: 20 sessões simuladas, com as três formas
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"versao":"v2"}' http://127.0.0.1:3000/admin/versao      # troca a versão no ar
make avaliar VERSAO=v1        # rascunho de issue sobre as sessões da v1 (precisa de ANTHROPIC_API_KEY)
make avaliar VERSAO=v1 SECO=1 # só o observado, sem chamar o modelo
```

- **O trace** (`traces/sala.jsonl`) tem uma linha por chamada: tool, argumentos estruturados, status, quantidade de itens, fontes declaradas como não lidas, ordem e duração. Argumento de texto livre vira tamanho e hash. O servidor nunca vê o prompt nem a resposta do agente.
- **O painel** agrupa as sessões pela sequência de tools e conta o que aconteceu depois da lista vazia: parou, conferiu a fonte ou procurou outra explicação. Uma sessão conta como encerrada depois de 30 s sem chamada.
- **O avaliador** calcula o observado por código, a partir dos traces, e manda ao modelo só esse observado, as formas mais comuns e a [rubrica](avaliador/rubrica.md). O modelo devolve o sinal, a hipótese de causa e o critério de fechamento; o rascunho mantém os dois separados.

**Publicar o servidor para a sala.** Só a porta do MCP sai para fora; o painel escuta em `127.0.0.1` numa porta separada (`PAINEL_PORT`, 3001), porque ele consulta o servidor a cada 2 s e, por um túnel com cota, meia sala com o painel aberto esgotaria a cota no meio da estação. Com o ngrok:

```bash
ngrok http 3000                                                    # mostra o domínio, ex.: nome.ngrok-free.dev
ALLOWED_HOSTS=nome.ngrok-free.dev ADMIN_TOKEN=... make servidor    # aceita o domínio público e segue aceitando localhost
```

O plano gratuito do ngrok tem um domínio fixo por conta e 20 mil requisições por mês; uma sala de 50 pessoas com duas perguntas cada usa perto de mil. Para quem abre o domínio no navegador, o ngrok mostra uma página de aviso; clientes MCP não são afetados. Com proxy próprio: `HOST=0.0.0.0 ALLOWED_HOSTS=mcp.seu-dominio`, atrás de TLS. Requer Node 22.18 ou mais novo (roda o TypeScript direto).

`TOOLS_OCULTAS=status_fontes` tira a tool do anúncio (ver "Resultados com agentes reais").

### Resultados com agentes reais

16/10/2026, Claude Code 2.1 com Opus, Sonnet e Haiku, a pergunta do slide, servidor pelo ngrok, sem outras ferramentas além do MCP:

| Servidor | v1 (lista vazia) | v2 (`null` com a fonte declarada) |
|---|---|---|
| Com `status_fontes` anunciada | 9 de 9 chamaram `status_fontes` e responderam que não dava para saber | 6 de 6 também acertaram; as sessões não ficaram mais curtas |
| Sem `status_fontes` | 3 de 3 responderam que não houve erros | 3 de 3 responderam que não conseguiram saber |

Com uma tool para conferir a fonte, os agentes testados contornaram o defeito; sem ela, a resposta deles dependeu só do que `buscar_erros` disse. O avaliador recebe, além dos traces, o estado das fontes na telemetria da plataforma, que o agente não vê: é assim que ele acha o sinal falso mesmo quando nenhuma sessão conferiu a fonte.

## Estação 2: verificações de CI para código escrito por agentes

```bash
make guardas
```

`guardas/catch-vazio.ts` varre `servidor/tools` e recusa todo `catch` que devolve lista vazia sem declarar a fonte que falhou. A forma certa é `return { erros: null, ...semFonte("logs", erro) }` (helper em `servidor/fontes.ts`). A exceção, quando é de propósito, fica escrita no código com o comentário `guarda:catch-vazio-proposital` e aparece no relatório: é o caso da v1 de `buscar_erros`.

A guarda tem a sua própria guarda: o relatório falha se a varredura não leu nenhum arquivo, e o teste (`guardas/catch-vazio.test.ts`) confere que a regra reconhece o padrão proibido num exemplo e ignora o padrão dentro de comentário.

## Estrutura

```
servidor/            servidor MCP de exemplo, gravador de trace, painel e simulador de sala
avaliador/           rubrica e avaliador dos traces
guardas/             a verificação de CI da estação 2 e os testes dela
estacao3/servico     api e estoque, v1 e v2
estacao3/carga       gerador de carga com log de contadores acumulados
estacao3/comparar    comparação de duas capturas, por request, contra o ruído
estacao3/assinante   cliente gRPC do stream do ptop, sem privilégio
preflight.sh         checagem da máquina, instalação do ptop e captura de teste
```

## Licença

MIT. O ptop tem licença e repositório próprios: [github.com/trentas/ptop](https://github.com/trentas/ptop).
