#!/usr/bin/env bash
# Preflight do kit: confere a máquina, instala o ptop com as capabilities,
# compila as ferramentas (ou, sem Go 1.25, baixa as da release do kit) e faz
# uma captura de teste de 5 segundos.
#
# Rode na máquina (ou VM) Linux que você vai levar ao workshop, até 04/11.
# No fim ele imprime um resumo para colar no formulário.
set -uo pipefail

PTOP_VERSAO="${PTOP_VERSAO:-1.9.1}"
CAPS="cap_bpf,cap_perfmon,cap_sys_admin,cap_dac_read_search,cap_sys_ptrace+ep"
cd "$(dirname "$0")"

falhas=0
resumo=()
ok()    { printf '  ok     %s\n' "$*"; }
aviso() { printf '  aviso  %s\n' "$*"; }
falha() { printf '  FALHA  %s\n' "$*"; falhas=$((falhas + 1)); }
anota() { resumo+=("$1"); }

echo "== máquina"
if [ "$(uname -s)" != Linux ]; then
  falha "o sistema é $(uname -s); o ptop precisa de Linux (use uma VM Linux)"
  anota "so=$(uname -s)"
else
  ok "Linux"
fi

case "$(uname -m)" in
  x86_64)        goarch=amd64 ;;
  aarch64|arm64) goarch=arm64 ;;
  *)             goarch=""; falha "arquitetura $(uname -m): o kit suporta amd64 e arm64" ;;
esac
anota "arch=$(uname -m)"

kernel="$(uname -r)"
maior="${kernel%%.*}"; resto="${kernel#*.}"; menor="${resto%%.*}"
if [ "$maior" -gt 5 ] 2>/dev/null || { [ "$maior" -eq 5 ] && [ "$menor" -ge 8 ]; } 2>/dev/null; then
  ok "kernel $kernel"
else
  falha "kernel $kernel: o ptop precisa de 5.8 ou mais novo"
fi
anota "kernel=$kernel"

if [ -r /sys/kernel/btf/vmlinux ]; then
  ok "BTF do kernel presente"
  anota "btf=sim"
else
  falha "sem /sys/kernel/btf/vmlinux: o kernel não expõe BTF, e o eBPF do ptop não carrega"
  anota "btf=nao"
fi

if command -v systemd-detect-virt >/dev/null && systemd-detect-virt --container --quiet; then
  aviso "parece um container; o workshop foi testado em Linux nativo e em VM"
fi

# Num sistema de arquivos montado com nosuid (o /tmp costuma ser), o kernel
# ignora as file capabilities: o setcap funciona e o ptop roda sem elas.
if command -v findmnt >/dev/null && findmnt -no OPTIONS -T . | tr ',' '\n' | grep -qx nosuid; then
  falha "a pasta do kit está em $(findmnt -no TARGET -T .), montado com nosuid: ali o kernel ignora as capabilities. Clone o kit na sua home"
fi

if sudo true; then
  ok "sudo"
else
  falha "sem sudo: ele é preciso uma vez, para aplicar as capabilities no ptop"
fi

# O Go é opcional: com 1.25 ou mais novo, as ferramentas são compiladas aqui;
# sem ele, vêm prontas da release do kit. A mesma regra está no Makefile (GO_OK).
go_ok=""
if command -v go >/dev/null; then
  gv="$(go env GOVERSION 2>/dev/null)"
  if [ "$(echo "$gv" | awk -F'[go.]' '{ if ($3 > 1 || ($3 == 1 && $4 >= 25)) print "sim" }')" = sim ]; then
    ok "$(go version)"
    go_ok=1
  else
    ok "$gv é anterior ao 1.25: as ferramentas vêm da release do kit"
  fi
else
  ok "sem Go: as ferramentas vêm da release do kit"
fi

echo
echo "== ptop $PTOP_VERSAO"
mkdir -p bin
if [ -n "$goarch" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/trentas/ptop/releases/download/v$PTOP_VERSAO"
  tarball="ptop-$PTOP_VERSAO-linux-$goarch.tar.gz"
  if curl -fsSL -o "$tmp/$tarball" "$url/$tarball" && curl -fsSL -o "$tmp/SHA256SUMS" "$url/SHA256SUMS"; then
    if (cd "$tmp" && grep " $tarball\$" SHA256SUMS | sha256sum -c - >/dev/null); then
      tar -xzf "$tmp/$tarball" -C "$tmp" ptop && install -m 0755 "$tmp/ptop" bin/ptop
      ok "baixado e conferido pelo SHA256SUMS da release"
    else
      falha "o checksum do $tarball não confere; não instalei"
    fi
  else
    falha "não consegui baixar $url/$tarball"
  fi
fi

if [ -x bin/ptop ]; then
  setcap_bin="$(command -v setcap || echo /usr/sbin/setcap)"
  if sudo "$setcap_bin" "$CAPS" bin/ptop; then
    ok "capabilities aplicadas: $CAPS"
  else
    falha "setcap falhou. Se o kit está numa pasta compartilhada da VM, clone-o no disco da própria VM"
  fi
  echo
  ./bin/ptop --caps | sed 's/^/  | /'
  if ./bin/ptop --caps | grep -q 'WILL NOT COLLECT\|none of them'; then
    falha "algum coletor não vai rodar: veja as linhas acima"
    anota "caps=incompleto"
  else
    anota "caps=completo"
  fi
fi

echo
echo "== ferramentas do kit"
if [ -n "$go_ok" ]; then
  if make -s build; then
    ok "compiladas em bin/"
    anota "ferramentas=compiladas"
  else
    falha "não compilaram"
  fi
elif [ -n "$goarch" ]; then
  base="${KIT_BINARIOS_URL:-https://github.com/trentas/platformcon-workshop-kit/releases/latest/download}"
  pacote="kit-linux-$goarch.tar.gz"
  mkdir -p "$tmp/kit"
  if curl -fsSL -o "$tmp/kit/$pacote" "$base/$pacote" && curl -fsSL -o "$tmp/kit/SHA256SUMS" "$base/SHA256SUMS"; then
    if (cd "$tmp/kit" && grep " $pacote\$" SHA256SUMS | sha256sum -c - >/dev/null); then
      tar -xzf "$tmp/kit/$pacote" -C bin
      ok "baixadas da release do kit e conferidas pelo SHA256SUMS"
      anota "ferramentas=release"
    else
      falha "o checksum do $pacote não confere; não instalei"
    fi
  else
    falha "não consegui baixar $base/$pacote; instale o Go 1.25 ou mais novo (https://go.dev/dl) e rode de novo"
  fi
fi

echo
echo "== captura de teste (5 s)"
if [ -x bin/ptop ] && [ -x bin/servico ]; then
  make -s subir VERSAO=v1
  sleep 1
  if make -s captura NOME=preflight DURACAO=5 > run/preflight-captura.log 2>&1 \
     && ./bin/comparar -a preflight -b preflight > run/preflight-comparar.log 2>&1 \
     && grep 'connect() por request' run/preflight-comparar.log | grep -qv 'não medido'; then
    ok "captura gravada e lida: capturas/preflight.jsonl"
    anota "captura=ok"
  else
    falha "a captura de teste falhou; veja run/preflight-captura.log e run/preflight-comparar.log"
    anota "captura=falhou"
  fi
  make -s parar
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "Tudo certo. Cole a linha abaixo no formulário do workshop:"
else
  echo "$falhas problema(s). Cole a linha abaixo no formulário mesmo assim, para a gente ajudar:"
fi
linha="preflight v1 · ${resumo[*]} · falhas=$falhas"
echo
echo "  $linha"
echo "$linha" > preflight-resultado.txt
exit $(( falhas > 0 ))
