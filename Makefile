# Kit do workshop "Quando o usuário da plataforma é um agente" — PlatformCon São Paulo 2026.

SHELL    := /bin/bash
SOCKET   ?= /tmp/ptop.sock
DURACAO  ?= 60
RPS      ?= 50

# PRONTAS=1 compara as capturas de reserva do kit (capturas/prontas/<arch>, da sua
# arquitetura ou da ARCH pedida) em vez das suas.
ARCH_KIT := $(shell uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
CAPTURAS := $(if $(PRONTAS),capturas/prontas/$(or $(ARCH),$(ARCH_KIT)),capturas)

# Com A=v1-a e uma captura v1-b no disco, a comparação mede o ruído contra ela.
RUIDO ?= $(if $(filter-out v1-b,$(B)),$(if $(wildcard $(CAPTURAS)/v1-b.jsonl),v1-b,),)

# Go 1.25 ou mais novo compila as ferramentas; sem ele, elas vêm da release (make preflight).
GO_OK := $(shell go env GOVERSION 2>/dev/null | awk -F'[go.]' '{ if ($$3 > 1 || ($$3 == 1 && $$4 >= 25)) print "sim" }')
FERRAMENTAS := servico carga comparar assinante

.PHONY: preflight build pacotes subir v1 v2 acompanhar parar captura comparar limpar servidor palco versao simular avaliar fumaca guardas checar

preflight:
	@./preflight.sh

build:
ifeq ($(GO_OK),sim)
	@mkdir -p bin
	@go build -o bin/ ./estacao3/...
else
	@for f in $(FERRAMENTAS); do test -x bin/$$f || { echo "sem Go 1.25 ou mais novo, e sem bin/$$f: rode make preflight"; exit 1; }; done
endif

# Os pacotes que a release publica: as ferramentas da estação 3 para amd64 e arm64,
# estáticas, e o SHA256SUMS que o preflight confere.
pacotes:
	@rm -rf dist && mkdir -p dist
	@for a in amd64 arm64; do \
	  d=dist/kit-linux-$$a; mkdir -p $$d; \
	  CGO_ENABLED=0 GOOS=linux GOARCH=$$a go build -trimpath -ldflags='-s -w' -o $$d/ ./estacao3/... || exit 1; \
	  tar -C $$d --owner=0 --group=0 --numeric-owner -czf dist/kit-linux-$$a.tar.gz $(FERRAMENTAS) || exit 1; \
	  rm -rf $$d; \
	done
	@cd dist && sha256sum kit-linux-*.tar.gz > SHA256SUMS && cat SHA256SUMS

# Sobe o estoque, a api na VERSAO pedida e a carga, cada um na própria sessão
# (setsid): o Ctrl-C do acompanhamento não derruba o serviço.
subir: build parar
	@test -n "$(VERSAO)" || { echo "uso: make subir VERSAO=v1"; exit 1; }
	@mkdir -p run
	@setsid ./bin/servico -papel estoque -pidfile run/estoque.pid > run/estoque.log 2>&1 < /dev/null &
	@setsid ./bin/servico -papel api -versao $(VERSAO) -pidfile run/servico.pid > run/servico.log 2>&1 < /dev/null &
	@sleep 0.5
	@setsid ./bin/carga -rps $(RPS) -log run/carga.jsonl -pidfile run/carga.pid > run/carga.log 2>&1 < /dev/null &
	@sleep 0.3
	@echo "$(VERSAO) no ar: api pid $$(cat run/servico.pid), $(RPS) req/s."

v1 v2:
	@$(MAKE) -s subir VERSAO=$@
	@echo "Latência a cada 10 s. Ctrl-C sai do acompanhamento; o serviço continua rodando."
	@tail -n +1 -f run/carga.log

acompanhar:
	@tail -n +1 -f run/carga.log

parar:
	@for p in carga servico estoque; do \
	  if [ -f run/$$p.pid ]; then \
	    pid=$$(cat run/$$p.pid); kill $$pid 2>/dev/null; \
	    for i in $$(seq 30); do kill -0 $$pid 2>/dev/null || break; sleep 0.1; done; \
	    rm -f run/$$p.pid; \
	  fi; \
	done

# Captura DURACAO segundos da api com o ptop e guarda, ao lado, o log da carga
# do mesmo período: é dele que o comparar tira os requests e a latência.
captura:
	@test -n "$(NOME)" || { echo "uso: make captura NOME=v1-a"; exit 1; }
	@test -f run/servico.pid || { echo "nada rodando: rode make v1 ou make v2 antes"; exit 1; }
	@mkdir -p capturas && rm -f ptop-events-*.jsonl
	@echo "capturando $(DURACAO) s da api (pid $$(cat run/servico.pid))..."
	timeout -s INT $(DURACAO) ./bin/ptop --pid $$(cat run/servico.pid) --serve unix://$(SOCKET) --export \
	  || test $$? -eq 124
	@sleep 1.5
	@mv "$$(ls -t ptop-events-*.jsonl | head -1)" capturas/$(NOME).jsonl
	@cp run/carga.jsonl capturas/$(NOME).carga.jsonl
	@echo "gravado: capturas/$(NOME).jsonl"

comparar: build
	@test -n "$(A)" -a -n "$(B)" || { echo "uso: make comparar A=v1-a B=v2"; exit 1; }
	@./bin/comparar -dir $(CAPTURAS) -a $(A) -b $(B) $(if $(RUIDO),-ruido $(RUIDO),); s=$$?; \
	  [ $$s -eq 3 ] && exit 0; exit $$s   # 3 = comparação recusada pela instrumentação: é resultado, não erro

limpar: parar
	rm -rf run ptop-events-*.jsonl

# --- estação 1: o servidor MCP de exemplo, o painel e o avaliador (lado do instrutor)

# MCP na PORT (3000); painel e admin só locais, na PAINEL_PORT (3001). Para publicar: ALLOWED_HOSTS=<domínio>.
servidor:
	@node servidor/index.ts

# No palco: o túnel do ngrok e o servidor juntos; Ctrl-C derruba os dois.
#   make palco DOMINIO=nome.ngrok-free.dev TRACES=traces/sala-0711.jsonl
palco:
	@test -n "$(DOMINIO)" || { echo "uso: make palco DOMINIO=nome.ngrok-free.dev [TRACES=traces/sala-DDMM.jsonl]"; exit 1; }
	@command -v ngrok >/dev/null || { echo "ngrok não encontrado"; exit 1; }
	@mkdir -p run
	@ngrok http $${PORT:-3000} --url=https://$(DOMINIO) --log=stdout > run/ngrok.log 2>&1 & ng=$$!; \
	  trap 'kill $$ng 2>/dev/null' EXIT INT TERM; \
	  echo "túnel: https://$(DOMINIO)/mcp (log do ngrok em run/ngrok.log)"; \
	  ALLOWED_HOSTS=$(DOMINIO) node servidor/index.ts

# make versao V=v2: troca a versão no ar, pela porta local.
versao:
	@test "$(V)" = v1 -o "$(V)" = v2 || { echo "uso: make versao V=v1|v2"; exit 1; }
	@curl -sS -X POST -H 'content-type: application/json' -d '{"versao":"$(V)"}' \
	  http://$${PAINEL_HOST:-127.0.0.1}:$${PAINEL_PORT:-3001}/admin/versao; echo

simular:
	@node servidor/simular-sala.ts --url $${URL:-http://127.0.0.1:3000/mcp} --sessoes $${SESSOES:-12}

# make avaliar VERSAO=v1 [SECO=1]
avaliar:
	@node avaliador/avaliar.ts --traces $${TRACES:-traces/sala.jsonl} --versao $${VERSAO:-v1} $(if $(SECO),--seco,)

# Teste de fumaça da estação 1, em portas próprias (3100 e 3101): sessões simuladas
# nas duas versões, a troca de versão pela porta local, a porta pública sem admin e
# o observado do avaliador, sem chamar o modelo.
fumaca:
	@mkdir -p run && rm -f run/fumaca.jsonl
	@PORT=3100 PAINEL_PORT=3101 TRACES=run/fumaca.jsonl node servidor/index.ts > run/fumaca.log 2>&1 & srv=$$!; \
	  trap 'kill $$srv 2>/dev/null' EXIT; \
	  for i in $$(seq 50); do curl -sf http://127.0.0.1:3100/saude >/dev/null && break; sleep 0.2; done; \
	  set -e; \
	  node servidor/simular-sala.ts --url http://127.0.0.1:3100/mcp --sessoes 6; \
	  test "$$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3100/admin/versao)" = 404; \
	  curl -sf -X POST -H 'content-type: application/json' -d '{"versao":"v2"}' http://127.0.0.1:3101/admin/versao > /dev/null; \
	  node servidor/simular-sala.ts --url http://127.0.0.1:3100/mcp --sessoes 6; \
	  node avaliador/avaliar.ts --traces run/fumaca.jsonl --versao v1 --seco 2>/dev/null > run/fumaca-v1.md; \
	  node avaliador/avaliar.ts --traces run/fumaca.jsonl --versao v2 --seco 2>/dev/null > run/fumaca-v2.md; \
	  grep -Eq '\b6 dessas respostas eram lista vazia' run/fumaca-v1.md; \
	  grep -Eq '\b6 dessas respostas eram erros: null' run/fumaca-v2.md; \
	  echo "fumaça ok: v1 com lista vazia, v2 com a fonte declarada, admin fora da porta pública"

# --- estação 2: a verificação de CI e a guarda da guarda

guardas:
	@node guardas/rodar.ts servidor/tools
	@npx vitest run guardas --reporter=dot

checar: guardas
	@npx tsc --noEmit
	@go vet ./...
	@go test ./...
