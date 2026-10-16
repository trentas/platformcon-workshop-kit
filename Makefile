# Kit do workshop "Quando o usuário da plataforma é um agente" — PlatformCon São Paulo 2026.
# Os alvos da estação 3 estão aqui; os das estações 1 e 2 entram junto com elas.

SHELL    := /bin/bash
SOCKET   ?= /tmp/ptop.sock
DURACAO  ?= 60
RPS      ?= 50

# Com A=v1-a e uma captura v1-b no disco, a comparação mede o ruído contra ela.
RUIDO ?= $(if $(filter-out v1-b,$(B)),$(if $(wildcard capturas/v1-b.jsonl),v1-b,),)

.PHONY: preflight build subir v1 v2 acompanhar parar captura comparar limpar servidor simular avaliar guardas checar

preflight:
	@./preflight.sh

build:
	@mkdir -p bin
	@go build -o bin/ ./estacao3/...

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
	@./bin/comparar -a $(A) -b $(B) $(if $(RUIDO),-ruido $(RUIDO),); s=$$?; \
	  [ $$s -eq 3 ] && exit 0; exit $$s   # 3 = comparação recusada pela instrumentação: é resultado, não erro

limpar: parar
	rm -rf run ptop-events-*.jsonl

# --- estação 1: o servidor MCP de exemplo, o painel e o avaliador (lado do instrutor)

servidor:
	@ADMIN_TOKEN=$${ADMIN_TOKEN:-dev} node servidor/index.ts

simular:
	@node servidor/simular-sala.ts --url $${URL:-http://127.0.0.1:3000/mcp} --sessoes $${SESSOES:-12}

# make avaliar VERSAO=v1 [SECO=1]
avaliar:
	@node avaliador/avaliar.ts --traces $${TRACES:-traces/sala.jsonl} --versao $${VERSAO:-v1} $(if $(SECO),--seco,)

# --- estação 2: a verificação de CI e a guarda da guarda

guardas:
	@node guardas/rodar.ts servidor/tools
	@npx vitest run guardas --reporter=dot

checar: guardas
	@npx tsc --noEmit
	@go vet ./...
