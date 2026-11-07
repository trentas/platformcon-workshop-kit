#!/usr/bin/env bash
# Gera as capturas de reserva do bloco 3, para quem não tem Linux funcionando:
# v1-a, v2 e v1-b com as capabilities completas, v1-parcial só com
# cap_bpf,cap_perfmon, e as três comparações em texto. Rode depois de um
# make preflight que passou. Saída em capturas/prontas/<arch>/.
set -euo pipefail
cd "$(dirname "$0")/.."
arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
dest="capturas/prontas/$arch"
duracao="${DURACAO:-30}"
completas="cap_bpf,cap_perfmon,cap_sys_admin,cap_dac_read_search,cap_sys_ptrace+ep"
setcap_bin="$(command -v setcap || echo /usr/sbin/setcap)"

capturar() { # versão nome
  make -s subir VERSAO="$1"
  sleep 5
  make -s captura NOME="$2" DURACAO="$duracao"
}
capturar v1 v1-a
capturar v2 v2
capturar v1 v1-b
sudo "$setcap_bin" cap_bpf,cap_perfmon+ep bin/ptop
capturar v1 v1-parcial
sudo "$setcap_bin" "$completas" bin/ptop
make -s parar

mkdir -p "$dest"
for n in v1-a v2 v1-b v1-parcial; do
  cp "capturas/$n.jsonl" "capturas/$n.carga.jsonl" "$dest/"
done
for b in v2 v1-b v1-parcial; do
  make -s comparar PRONTAS=1 A=v1-a B="$b" > "$dest/comparar-v1-a-$b.txt"
done
{
  echo "máquina: $(uname -m), kernel $(uname -r)"
  echo "$(./bin/ptop -version 2>&1 | head -1)"
  echo "capturas de $duracao s, em $(date -u +%Y-%m-%d)"
} > "$dest/ORIGEM.txt"
echo "capturas de reserva em $dest"
