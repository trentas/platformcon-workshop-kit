# Quando o usuário da plataforma é um agente

Kit do workshop da **PlatformCon São Paulo, 07/11/2026**. Do trace de uso à verificação no kernel, com MCP, CI e eBPF.

São três estações:

| Estação | O que se faz | Onde roda |
|---|---|---|
| 1. Agentes como usuários de um servidor MCP | O seu agente consulta um servidor de exemplo; os traces da sala viram rascunho de issue | No seu agente, contra um servidor nosso |
| 2. Verificações de CI para código escrito por agentes | Demonstração | Telão |
| 3. Comparação de versões com eBPF (ptop) | Captura de duas versões de um serviço e comparação contra o ruído | Na sua máquina Linux ou VM |

> **Estado do kit:** as três estações estão escritas. A estação 3 foi testada de ponta a ponta (arm64, kernel 7.0). A estação 1 foi testada com sessões simuladas e com agentes Claude pelo túnel, e o avaliador contra o modelo (v1: sinal falso; v2: nenhum achado). Falta testar a estação 1 com outros agentes.

## Antes do workshop: o preflight

Você precisa de:

- Linux nativo ou uma VM Linux (no Mac com Apple Silicon: UTM, Parallels, Lima ou OrbStack);
- kernel 5.8 ou mais novo, com BTF (`/sys/kernel/btf/vmlinux`), em amd64 ou arm64;
- `sudo`, uma vez, para aplicar as capabilities no ptop;
- git e make;
- Go 1.25 ou mais novo é opcional: sem ele, o preflight baixa as ferramentas já compiladas da release do kit;
- um agente de IA compatível com MCP (Claude Code, Cursor, VS Code, Gemini CLI, Codex…), para a estação 1.

Clone o kit **na sua home, no disco da própria máquina ou VM**. Numa pasta compartilhada com o host, o `setcap` falha por falta de atributos estendidos. No `/tmp`, que costuma ser montado com `nosuid`, o `setcap` funciona e o kernel ignora as capabilities. O preflight acusa os dois casos. Depois rode:

```bash
make preflight
```

O preflight confere a máquina, baixa o [ptop](https://github.com/trentas/ptop) da release (conferindo o `SHA256SUMS`), aplica as capabilities, compila as ferramentas (sem Go, baixa as da release do kit, também conferidas pelo `SHA256SUMS`) e faz uma captura de teste de 5 segundos. No fim ele imprime uma linha para colar no formulário do workshop.

### Sobre as capabilities

O preflight roda:

```bash
sudo setcap cap_bpf,cap_perfmon,cap_sys_admin,cap_dac_read_search,cap_sys_ptrace+ep ./bin/ptop
```

`cap_sys_admin` é quase root na prática. Conceda numa VM de laboratório, ou rode sem ela e use `./bin/ptop --caps` para ver o que deixou de coletar. O [README do ptop](https://github.com/trentas/ptop) explica o que cada uma libera.

## Estação 1: conectar o seu agente

No dia, o servidor da sala fica em:

```
https://crushed-dehydrate-fruit.ngrok-free.dev/mcp
```

Ele só responde durante o workshop. Depois, suba uma cópia local com `make servidor` e use `http://127.0.0.1:3000/mcp`.

Abra o agente numa pasta vazia, fora do kit, e configure o servidor com o nome `plataforma`:

| Agente | Onde | Configuração |
|---|---|---|
| Claude Code | terminal | `claude mcp add --transport http plataforma <endereço>` |
| Cursor | `~/.cursor/mcp.json` | `{"mcpServers": {"plataforma": {"url": "<endereço>"}}}` |
| VS Code (Copilot, modo agente) | `.vscode/mcp.json` | `{"servers": {"plataforma": {"type": "http", "url": "<endereço>"}}}` |
| Gemini CLI | `~/.gemini/settings.json` | `{"mcpServers": {"plataforma": {"httpUrl": "<endereço>"}}}` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.plataforma]` e, na linha de baixo, `url = "<endereço>"` |

Reinicie o agente depois de mudar a configuração. Para conferir, peça ao agente a lista de tools do servidor `plataforma`: são três, `listar_servicos`, `listar_deploys` e `buscar_erros`.

Até aqui, só o Claude Code foi testado contra o servidor. As outras linhas seguem a documentação de cada agente e serão conferidas no ensaio. Se o seu agente conecta mas não lista as tools, acrescente o cabeçalho `ngrok-skip-browser-warning: 1` à configuração (ver "Publicar o servidor para a sala", abaixo).

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

### Resultado nas capturas de reserva

As capturas de `capturas/prontas/` têm 30 s cada, com o ptop 1.9.0. O `ORIGEM.txt` de cada pasta diz onde foram feitas. `make comparar PRONTAS=1 A=v1-a B=v2` reproduz a tabela da sua arquitetura; `ARCH=amd64` ou `ARCH=arm64` escolhe a outra. Em arm64 (kernel 7.0):

```
métrica                     v1-a    v2      diferença   ruído
latência p50 (ms)           11,82   11,82   +0,00       0,00    dentro do ruído
latência p99 (ms)           13,68   14,36   +0,68       0,00    dentro do ruído
connect() por request       0,00    1,00    +1,00       0,00    acima do ruído
socket() por request        0,00    1,00    +1,00       0,00    acima do ruído
close() por request         0,00    1,00    +1,00       0,00    acima do ruído
setsockopt() por request    0,00    5,01    +5,01       0,00    acima do ruído
epoll_pwait() por request   5,59    8,10    +2,51       0,06    acima do ruído
futex() por request         10,96   13,46   +2,50       0,00    acima do ruído
nanosleep() por request     6,63    8,71    +2,08       0,06    acima do ruído
epoll_ctl() por request     0,00    2,00    +2,00       0,00    acima do ruído
```

Pela latência, a v2 passaria num teste de carga comum. No kernel, cada request passou a abrir e fechar uma conexão (connect, socket, close, setsockopt, epoll_ctl), e o runtime do Go passou a fazer de 2 a 4 chamadas a mais de nanosleep, futex e epoll_pwait. A causa exata dessas três não foi medida.

Numa VM amd64 limpa (o job sob demanda do CI: Ubuntu 24.04, kernel 6.17), as syscalls mudam do mesmo jeito. A latência é a métrica instável. Nas capturas de reserva de amd64, a mediana não mudou e o p99 foi de 12,41 para 13,68 ms. São dois degraus do histograma, e a variação ficou um pouco acima do piso de 10%. Numa rodada anterior na mesma VM, o p99 ficou dentro do ruído.

Sem Linux funcionando, use as capturas de reserva no lugar das suas: `make comparar PRONTAS=1 A=v1-a B=v2`, `A=v1-a B=v1-b` e `A=v1-a B=v1-parcial`. Para medir o ruído contra uma v1-a sua sem ter feito a v1-b, copie a de reserva: `cp capturas/prontas/<arch>/v1-b.* capturas/`.

### Como a comparação conta

- A janela de uma captura vai do primeiro ao último snapshot de syscalls do ptop. Os requests dessa janela vêm do log da carga, interpolado nos dois instantes.
- Uma métrica que não pôde ser medida aparece como `não medido`, nunca como zero.
- Uma diferença é marcada quando passa o dobro da variação entre `v1-a` e `v1-b` e também um piso: 5% (ou 0,02 por request) nas syscalls e 10% na latência, porque o histograma de latência tem resolução de 5%.

## Estação 1: o lado do instrutor

O servidor de exemplo se chama `plataforma` e anuncia três tools: `listar_servicos`, `listar_deploys` e `buscar_erros`. Uma quarta, `status_fontes`, existe e fica oculta por padrão (`TOOLS_OCULTAS`; ver os resultados abaixo). A fonte de logs está fora do ar desde o início. Na v1, `buscar_erros` devolve `{"erros": []}`, como se não houvesse erro; na v2, devolve `{"erros": null, "fontes": {"logs": "indisponivel"}}`. Lista vazia quer dizer "li e não havia nada"; `null` com a fonte declarada quer dizer "não li".

```bash
make servidor                 # MCP em http://127.0.0.1:3000/mcp; painel em http://127.0.0.1:3001/painel
make simular SESSOES=20       # ensaio: 20 sessões simuladas, com as três formas
make versao V=v2              # troca a versão no ar
make avaliar VERSAO=v1        # rascunho de issue sobre as sessões da v1 (precisa de ANTHROPIC_API_KEY)
make avaliar VERSAO=v1 SECO=1 # só o observado, sem chamar o modelo
make fumaca                   # teste de fumaça em portas próprias (3100 e 3101), sem chamar o modelo
```

- **O trace** (`traces/sala.jsonl`) tem uma linha por chamada: tool, argumentos estruturados, status, quantidade de itens, fontes declaradas como não lidas, ordem e duração. Argumento de texto livre vira tamanho e hash. O servidor nunca vê o prompt nem a resposta do agente.
- **O painel** agrupa as sessões pela sequência de tools e conta o que aconteceu depois da resposta sem erros: parou ou procurou outra explicação (e, com `status_fontes` anunciada, conferiu a fonte). Ao lado, quantas receberam o aviso de logs não lidos. O número de quem parou fica em âmbar só quando alguma sessão parou sem ter recebido o aviso: parar depois do aviso é a resposta certa. Uma sessão conta como encerrada depois de 30 s sem chamada. A página se reduz para caber na tela sem rolar.
- **O avaliador** calcula o observado por código, a partir dos traces, e manda ao modelo só esse observado, as formas mais comuns e a [rubrica](avaliador/rubrica.md). O modelo devolve o sinal, a hipótese de causa e o critério de fechamento; o rascunho mantém os dois separados.

**Publicar o servidor para a sala.** O servidor roda na máquina de quem conduz. Só a porta do MCP sai para fora. O painel e as rotas de admin (`/admin/versao`, `/admin/traces`) escutam em `127.0.0.1`, numa porta separada (`PAINEL_PORT`, 3001), e não pedem senha. O painel consulta o servidor a cada 2 s: por um túnel com cota, meia sala com ele aberto esgotaria a cota no meio da estação. A troca de versão fica local porque nada que muda o servidor precisa estar na internet. Com o ngrok:

```bash
make palco DOMINIO=nome.ngrok-free.dev TRACES=traces/sala-0711.jsonl   # túnel e servidor juntos; Ctrl-C derruba os dois
```

O plano gratuito do ngrok tem um domínio fixo por conta e 20 mil requisições por mês; uma sala de 50 pessoas com duas perguntas cada usa perto de mil.

Para requisições GET com User-Agent de navegador, o ngrok gratuito devolve uma página de aviso no lugar da resposta. As chamadas de tool (POST) passam com qualquer User-Agent. O que recebe a página é o GET que o cliente MCP abre para o stream de eventos do servidor, se o cliente se identificar como navegador. O cliente do SDK oficial em TypeScript seguiu funcionando nesse caso, testado com o User-Agent do VS Code. Um cliente que trate o stream como obrigatório pode falhar. O cabeçalho `ngrok-skip-browser-warning` com qualquer valor desliga a página.

Servidor numa VM e navegador no host: o painel precisa escutar num endereço que o host alcança, por exemplo `PAINEL_HOST=10.211.55.3` (o IP da VM na rede compartilhada do Parallels; `ip -4 addr` mostra o seu). Com a VM em rede compartilhada (NAT), esse endereço só é visível para o host. Em modo bridge, ele fica visível para a rede da sala.

Com proxy próprio: `HOST=0.0.0.0 ALLOWED_HOSTS=mcp.seu-dominio`, atrás de TLS, e o painel por SSH (`ssh -L 3001:127.0.0.1:3001 <máquina>`). Requer Node 22.18 ou mais novo (roda o TypeScript direto).

`TOOLS_OCULTAS=status_fontes` tira a tool do anúncio (ver "Resultados com agentes reais").

### Resultados com agentes reais

16/10/2026, Claude Code 2.1 com Opus, Sonnet e Haiku, a pergunta do slide, servidor pelo ngrok, sem outras ferramentas além do MCP:

| Servidor | v1 (lista vazia) | v2 (`null` com a fonte declarada) |
|---|---|---|
| Com `status_fontes` anunciada | 9 de 9 chamaram `status_fontes` e responderam que não dava para saber | 6 de 6 também acertaram; as sessões não ficaram mais curtas |
| Sem `status_fontes`, aviso com "timeout" | 3 de 3 responderam que não houve erros | 3 de 3 responderam que não conseguiram saber, repetindo a consulta |
| **Padrão do kit:** sem `status_fontes`, aviso "repetir a consulta não resolve" | **6 de 6 responderam que não houve erros** | **6 de 6 responderam que não conseguiram verificar**, sem repetir |

Com uma tool para conferir a fonte, os agentes testados contornaram o defeito; sem ela, a resposta deles dependeu só do que `buscar_erros` disse. O avaliador recebe, além dos traces, o estado das fontes na telemetria da plataforma, que o agente não vê: é assim que ele acha o sinal falso mesmo quando nenhuma sessão conferiu a fonte. Nas sessões do padrão do kit, ele apontou `sinal_falso` na v1 (confiança alta) e "nenhum achado" na v2.

Só agentes Claude foram testados até aqui.

## Estação 2: verificações de CI para código escrito por agentes

```bash
make guardas
```

`guardas/catch-vazio.ts` varre `servidor/tools` e recusa todo `catch` que devolve lista vazia sem declarar a fonte que falhou. A forma certa é `return { erros: null, ...semFonte("logs", erro) }` (helper em `servidor/fontes.ts`). A exceção, quando é de propósito, fica escrita no código com o comentário `guarda:catch-vazio-proposital` e aparece no relatório: é o caso da v1 de `buscar_erros`.

A guarda tem a sua própria guarda: o relatório falha se a varredura não leu nenhum arquivo, e o teste (`guardas/catch-vazio.test.ts`) confere que a regra reconhece o padrão proibido num exemplo e ignora o padrão dentro de comentário.

## VMs reserva (lado do instrutor)

`vm-reserva/cloud-init.yaml` sobe uma VM para a estação 3 em qualquer nuvem que aceite cloud-init (o campo user-data), com Ubuntu 24.04, 2 vCPU e 4 GB. Ela cria o usuário `kit`, com sudo e entrada por SSH com senha, clona o kit, roda o preflight com as ferramentas da release e se desliga sozinha 6 horas depois.

Cada VM precisa de uma senha própria, que o monitor entrega ao participante junto com o IP:

```bash
sed "s/TROQUE-ESTA-SENHA/$(openssl rand -base64 12 | tr -d '/+=')/" vm-reserva/cloud-init.yaml > /tmp/vm-01.yaml
```

Se a nuvem permitir, restrinja a porta 22 ao IP de saída da Wi-Fi do evento. Para conferir uma VM: `ssh kit@<ip> cat platformcon-workshop-kit/preflight-resultado.txt`.

Até aqui, o arquivo só teve o schema validado (`cloud-init schema`). Ele ainda não subiu numa nuvem, porque clona o kit e baixa as ferramentas da release, e as duas coisas dependem do repo público.

## Release

Uma tag `v*` dispara `.github/workflows/release.yml`: as ferramentas da estação 3 compiladas para amd64 e arm64 (`kit-linux-<arch>.tar.gz`) e o `SHA256SUMS` vão para a release, de onde o preflight as baixa quando não há Go. `make pacotes` gera os mesmos arquivos em `dist/`. Sem tag, o workflow roda sob demanda e deixa os pacotes como artefato, sem publicar.

## Estrutura

```
servidor/            servidor MCP de exemplo, gravador de trace, painel e simulador de sala
avaliador/           rubrica e avaliador dos traces
guardas/             a verificação de CI da estação 2 e os testes dela
estacao3/servico     api e estoque, v1 e v2
estacao3/carga       gerador de carga com log de contadores acumulados
estacao3/comparar    comparação de duas capturas, por request, contra o ruído
estacao3/assinante   cliente gRPC do stream do ptop, sem privilégio
estacao3/capturas-de-reserva.sh   gera as capturas de capturas/prontas/<arch>/
capturas/prontas/    capturas de reserva da estação 3, de arm64 e amd64
preflight.sh         checagem da máquina, instalação do ptop e captura de teste
vm-reserva/          cloud-init das VMs reserva da estação 3
```

## Licença

MIT. O ptop tem licença e repositório próprios: [github.com/trentas/ptop](https://github.com/trentas/ptop).
