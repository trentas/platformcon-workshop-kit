// Compara duas capturas do ptop da estação 3, por request.
//
// Antes dos números, compara a instrumentação: se algum coletor tem estado ou
// fonte diferente entre as duas capturas, a diferença nos números pode ser só a
// diferença de instrumentação, e a comparação é recusada.
//
// Cada métrica é medida na janela da captura (do primeiro ao último snapshot de
// syscalls) e dividida pelos requests que a carga completou nessa mesma janela.
// Com -ruido, a mesma conta é feita entre A e uma segunda captura da mesma versão,
// e só a diferença maior que essa variação é marcada.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	pb "github.com/trentas/ptop/pkg/streampb"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/trentas/platformcon-workshop-kit/estacao3/internal/histo"
)

// sempre aparecem na tabela, mesmo sem mudança: são as que a v2 mexe.
var syscallsFixas = []string{"connect", "socket", "close"}

func main() {
	dir := flag.String("dir", "capturas", "pasta das capturas")
	a := flag.String("a", "", "nome da captura de referência (ex.: v1-a)")
	b := flag.String("b", "", "nome da captura comparada (ex.: v2)")
	ruido := flag.String("ruido", "", "segunda captura da mesma versão de A (ex.: v1-b), para medir a variação")
	flag.Parse()
	if *a == "" || *b == "" {
		fmt.Fprintln(os.Stderr, "uso: comparar -a v1-a -b v2 [-ruido v1-b]")
		os.Exit(2)
	}

	ca := ler(*dir, *a)
	cb := ler(*dir, *b)
	var cr *captura
	if *ruido != "" {
		cr = ler(*dir, *ruido)
	}

	fmt.Printf("comparar %s × %s", ca.nome, cb.nome)
	if cr != nil {
		fmt.Printf("   (ruído: %s × %s)", ca.nome, cr.nome)
	}
	fmt.Print("\n\n")

	// 1. a instrumentação, antes de qualquer número
	pares := []*captura{cb}
	if cr != nil {
		pares = append(pares, cr)
	}
	recusa := false
	for _, outra := range pares {
		if dif := diferencasDeColetor(ca, outra); len(dif) > 0 {
			fmt.Printf("coletores diferentes entre %s e %s:\n", ca.nome, outra.nome)
			for _, l := range dif {
				fmt.Println("  " + l)
			}
			recusa = true
		}
	}
	if recusa {
		fmt.Println("\nnúmeros não comparados:")
		fmt.Println("a diferença entre as capturas pode ser só de instrumentação.")
		os.Exit(3)
	}
	if !ca.temProbes || !cb.temProbes {
		fmt.Println("aviso: uma das capturas não traz o estado dos coletores (ptop antigo); a instrumentação não foi conferida.")
	}
	if parados := naoAtivos(ca); len(parados) > 0 {
		fmt.Printf("coletores que não rodaram nas capturas: %s\n", strings.Join(parados, ", "))
	}

	// 2. a janela de cada captura
	for _, c := range append([]*captura{ca, cb}, pares[1:]...) {
		fmt.Printf("janela %-10s %s\n", c.nome, c.descreveJanela())
	}
	fmt.Println()

	// 3. as métricas
	ma, mb := ca.metricas(), cb.metricas()
	var mr map[string]float64
	if cr != nil {
		mr = cr.metricas()
	}
	completarSyscalls(ma, mb, mr)
	nomes := escolherMetricas(ma, mb)

	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
	fmt.Fprintf(tw, "métrica\t%s\t%s\tdiferença\truído\t\n", ca.nome, cb.nome)
	for _, n := range nomes {
		va, oka := ma[n]
		vb, okb := mb[n]
		if !oka || !okb {
			fmt.Fprintf(tw, "%s\t%s\t%s\t—\t—\tnão medido\n", rotulo(n), num(va, oka), num(vb, okb))
			continue
		}
		dif := vb - va
		col, veredito := "—", "sem captura de ruído"
		if mr != nil {
			if vr, ok := mr[n]; ok {
				r := math.Abs(vr - va)
				col = num(r, true)
				veredito = "dentro do ruído"
				if acimaDoRuido(n, dif, r, va) {
					veredito = "acima do ruído"
				}
			} else {
				veredito = "ruído não medido"
			}
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", rotulo(n), num(va, true), num(vb, true), sinal(dif), col, veredito)
	}
	tw.Flush()
	if mr == nil {
		fmt.Println("\nNenhuma diferença foi marcada: falta uma segunda captura da versão de A para medir o ruído")
		fmt.Println("(make captura NOME=v1-b). Se A e B já são a mesma versão, a coluna diferença é o próprio ruído.")
	}
}

// acimaDoRuido: a diferença precisa passar o dobro da variação entre duas
// execuções da mesma versão, e também um piso, para que uma variação medida
// como zero não transforme qualquer oscilação em achado. O piso de syscall é
// 5% do valor de A ou 0,02 por request. O de latência é 10%: o histograma tem
// baldes de 5%, então mudar um balde é a resolução da medida, não um achado.
func acimaDoRuido(metrica string, dif, ruido, base float64) bool {
	piso := math.Max(0.02, 0.05*math.Abs(base))
	if strings.HasPrefix(metrica, "lat:") {
		piso = 0.10 * math.Abs(base)
	}
	return math.Abs(dif) > math.Max(2*ruido, piso)
}

type probe struct{ estado, fonte string }

type snapshot struct {
	t      int64
	counts map[string]uint64
}

type captura struct {
	nome           string
	temProbes      bool
	probes         map[string]probe
	primeiro, fim  *snapshot
	carga          []cargaLinha
	cargaAusente   bool
	descartadasMal int
}

type cargaLinha struct {
	T     int64      `json:"t"`
	N     uint64     `json:"n"`
	Erros uint64     `json:"erros"`
	Hist  histo.Hist `json:"hist"`
}

func ler(dir, nome string) *captura {
	c := &captura{nome: nome, probes: map[string]probe{}}
	arq, err := os.Open(filepath.Join(dir, nome+".jsonl"))
	if err != nil {
		morre("abrir a captura %s: %v", nome, err)
	}
	defer arq.Close()
	sc := bufio.NewScanner(arq)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var r pb.SubscribeResponse
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(sc.Bytes(), &r); err != nil {
			c.descartadasMal++
			continue
		}
		if t := r.GetMeta().GetTarget(); t != nil && !c.temProbes {
			for _, p := range t.GetProbes() {
				c.probes[p.GetName()] = probe{estado: estadoCurto(p.GetState()), fonte: p.GetSource()}
			}
			c.temProbes = len(c.probes) > 0
			continue
		}
		ev := r.GetEvent()
		if ev.GetSyscalls() == nil {
			continue
		}
		s := &snapshot{t: ev.GetTsUnixNano(), counts: map[string]uint64{}}
		for _, st := range ev.GetSyscalls().GetStats() {
			s.counts[st.GetName()] = st.GetCount()
		}
		if c.primeiro == nil {
			c.primeiro = s
		}
		c.fim = s
	}
	if err := sc.Err(); err != nil {
		morre("ler a captura %s: %v", nome, err)
	}
	c.carga, err = lerCarga(filepath.Join(dir, nome+".carga.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		c.cargaAusente = true
	} else if err != nil {
		morre("ler a carga de %s: %v", nome, err)
	}
	return c
}

func lerCarga(path string) ([]cargaLinha, error) {
	arq, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer arq.Close()
	var out []cargaLinha
	dec := json.NewDecoder(arq)
	for dec.More() {
		var l cargaLinha
		if err := dec.Decode(&l); err != nil {
			return out, err
		}
		out = append(out, l)
	}
	return out, nil
}

// janelaCarga devolve as linhas da carga que delimitam a janela da captura:
// a última antes do início e a primeira depois do fim.
func (c *captura) janelaCarga() (ini, fim *cargaLinha, ok bool) {
	if c.primeiro == nil || len(c.carga) < 2 {
		return nil, nil, false
	}
	for i := range c.carga {
		if c.carga[i].T <= c.primeiro.t {
			ini = &c.carga[i]
		}
		if c.carga[i].T >= c.fim.t && fim == nil {
			fim = &c.carga[i]
		}
	}
	if ini == nil || fim == nil || fim.N <= ini.N {
		return nil, nil, false
	}
	return ini, fim, true
}

// requestsNaJanela interpola o contador acumulado da carga nos instantes exatos
// do primeiro e do último snapshot de syscalls. Sem isso, os requests viriam da
// janela de segundos inteiros da carga, até 2 s maior que a da captura, e o
// "por request" sairia menor do que é.
func (c *captura) requestsNaJanela() (req, erros float64, ok bool) {
	if _, _, ok := c.janelaCarga(); !ok {
		return 0, 0, false
	}
	n0, e0 := c.cargaEm(c.primeiro.t)
	n1, e1 := c.cargaEm(c.fim.t)
	if n1 <= n0 {
		return 0, 0, false
	}
	return n1 - n0, e1 - e0, true
}

func (c *captura) cargaEm(t int64) (n, erros float64) {
	for i := 1; i < len(c.carga); i++ {
		a, b := c.carga[i-1], c.carga[i]
		if t >= a.T && t <= b.T && b.T > a.T {
			f := float64(t-a.T) / float64(b.T-a.T)
			return float64(a.N) + f*float64(b.N-a.N), float64(a.Erros) + f*float64(b.Erros-a.Erros)
		}
	}
	ult := c.carga[len(c.carga)-1]
	return float64(ult.N), float64(ult.Erros)
}

func (c *captura) descreveJanela() string {
	if c.primeiro == nil {
		return "sem snapshot de syscalls"
	}
	seg := float64(c.fim.t-c.primeiro.t) / float64(time.Second)
	if req, erros, ok := c.requestsNaJanela(); ok {
		return virgula(fmt.Sprintf("%.1f s, %.0f requests, %.0f erros", seg, req, erros))
	}
	if c.cargaAusente {
		return virgula(fmt.Sprintf("%.1f s, sem log da carga: nada por request", seg))
	}
	return virgula(fmt.Sprintf("%.1f s, a carga não cobre a janela: nada por request", seg))
}

// metricas devolve o valor por request de cada métrica. Métrica que não pôde
// ser medida fica de fora do mapa — nunca entra como zero.
func (c *captura) metricas() map[string]float64 {
	out := map[string]float64{}
	ini, fim, ok := c.janelaCarga()
	if !ok {
		return out
	}
	req, _, _ := c.requestsNaJanela()
	// A latência vem da janela da carga que contém a captura (até 1 s a mais
	// de cada lado): o histograma acumulado não se interpola.
	janela := fim.Hist.Menos(ini.Hist)
	if p, ok := janela.Percentil(50); ok {
		out["lat:p50"] = float64(p) / float64(time.Millisecond)
	}
	if p, ok := janela.Percentil(99); ok {
		out["lat:p99"] = float64(p) / float64(time.Millisecond)
	}
	if c.primeiro == nil || c.primeiro == c.fim {
		return out
	}
	if pr, existe := c.probes["syscalls"]; existe && pr.estado != "active" {
		return out
	}
	nomes := map[string]bool{}
	for n := range c.fim.counts {
		nomes[n] = true
	}
	for _, n := range syscallsFixas {
		nomes[n] = true
	}
	for n := range nomes {
		d := float64(c.fim.counts[n]) - float64(c.primeiro.counts[n])
		if d < 0 {
			d = 0
		}
		out["sys:"+n] = d / req
	}
	return out
}

// completarSyscalls: uma syscall que aparece numa captura e não em outra, com o
// coletor de syscalls ativo nas duas, foi chamada zero vezes na segunda. Sem
// isto, a syscall que só a v2 faz ficava fora da tabela, porque a escolha das
// métricas parte das que existem em A. Captura sem dado de syscall (coletor
// parado) não ganha zeros: lá continua "não medido".
func completarSyscalls(ms ...map[string]float64) {
	comDado := func(m map[string]float64) bool {
		_, ok := m["sys:"+syscallsFixas[0]]
		return ok
	}
	todas := map[string]bool{}
	for _, m := range ms {
		if !comDado(m) {
			continue
		}
		for n := range m {
			if strings.HasPrefix(n, "sys:") {
				todas[n] = true
			}
		}
	}
	for _, m := range ms {
		if !comDado(m) {
			continue
		}
		for n := range todas {
			if _, ok := m[n]; !ok {
				m[n] = 0
			}
		}
	}
}

// escolherMetricas: latência, as syscalls fixas e as 5 outras que mais mudaram.
func escolherMetricas(a, b map[string]float64) []string {
	out := []string{"lat:p50", "lat:p99"}
	for _, n := range syscallsFixas {
		out = append(out, "sys:"+n)
	}
	fixas := map[string]bool{}
	for _, n := range out {
		fixas[n] = true
	}
	type cand struct {
		n string
		d float64
	}
	var cs []cand
	for n, va := range a {
		if fixas[n] || !strings.HasPrefix(n, "sys:") {
			continue
		}
		vb, ok := b[n]
		if !ok || (va < 0.01 && vb < 0.01) {
			continue
		}
		cs = append(cs, cand{n, math.Abs(vb - va)})
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].d > cs[j].d })
	for i := 0; i < len(cs) && i < 5; i++ {
		out = append(out, cs[i].n)
	}
	return out
}

func diferencasDeColetor(a, b *captura) []string {
	if !a.temProbes || !b.temProbes {
		return nil
	}
	nomes := map[string]bool{}
	for n := range a.probes {
		nomes[n] = true
	}
	for n := range b.probes {
		nomes[n] = true
	}
	var ord []string
	for n := range nomes {
		ord = append(ord, n)
	}
	sort.Strings(ord)
	var out []string
	for _, n := range ord {
		pa, pb := a.probes[n], b.probes[n]
		if pa != pb {
			out = append(out, fmt.Sprintf("%-9s %s: %-14s %s: %s", n, a.nome, pa.descreve(), b.nome, pb.descreve()))
		}
	}
	return out
}

func naoAtivos(c *captura) []string {
	var out []string
	for n, p := range c.probes {
		if p.estado != "active" {
			out = append(out, fmt.Sprintf("%s (%s)", n, p.estado))
		}
	}
	sort.Strings(out)
	return out
}

func (p probe) descreve() string {
	if p.estado == "" {
		return "ausente"
	}
	if p.fonte != "" {
		return p.estado + " (" + p.fonte + ")"
	}
	return p.estado
}

func estadoCurto(s pb.ProbeState) string {
	return strings.ToLower(strings.TrimPrefix(s.String(), "PROBE_STATE_"))
}

func rotulo(n string) string {
	switch n {
	case "lat:p50":
		return "latência p50 (ms)"
	case "lat:p99":
		return "latência p99 (ms)"
	}
	return strings.TrimPrefix(n, "sys:") + "() por request"
}

func num(v float64, ok bool) string {
	if !ok {
		return "não medido"
	}
	return virgula(fmt.Sprintf("%.2f", v))
}

func sinal(v float64) string { return virgula(fmt.Sprintf("%+.2f", v)) }

func virgula(s string) string { return strings.ReplaceAll(s, ".", ",") }

func morre(f string, args ...any) {
	fmt.Fprintf(os.Stderr, f+"\n", args...)
	os.Exit(1)
}
