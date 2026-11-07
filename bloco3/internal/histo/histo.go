// Package histo é um histograma de latência com baldes logarítmicos fixos.
//
// Os baldes são os mesmos em toda execução, então dois histogramas acumulados
// podem ser subtraídos: o que a carga gravou no fim de uma captura menos o que
// gravou no início é a latência daquela janela, e só dela.
package histo

import (
	"math"
	"sort"
	"time"
)

const (
	base     = 10.0 // microssegundos: limite superior do primeiro balde
	razao    = 1.05 // cada balde é 5% maior que o anterior
	nBaldes  = 330  // cobre de 10 µs até ~100 s
	logRazao = 0.04879016416943205
)

// Hist guarda a contagem por balde, em mapa esparso para a linha de log ficar curta.
type Hist map[int]uint64

// Balde devolve o índice do balde de uma latência.
func Balde(d time.Duration) int {
	us := float64(d) / float64(time.Microsecond)
	if us <= base {
		return 0
	}
	i := int(math.Ceil(math.Log(us/base) / logRazao))
	if i >= nBaldes {
		return nBaldes - 1
	}
	return i
}

// LimiteSuperior é a maior latência que cai no balde i.
func LimiteSuperior(i int) time.Duration {
	return time.Duration(base * math.Pow(razao, float64(i)) * float64(time.Microsecond))
}

// Menos devolve h − anterior, balde a balde.
func (h Hist) Menos(anterior Hist) Hist {
	out := Hist{}
	for i, n := range h {
		if n > anterior[i] {
			out[i] = n - anterior[i]
		}
	}
	return out
}

// Total é o número de amostras.
func (h Hist) Total() uint64 {
	var t uint64
	for _, n := range h {
		t += n
	}
	return t
}

// Percentil devolve o limite superior do balde onde o percentil p (0–100) cai,
// e false quando o histograma está vazio: sem amostra não há latência, e zero
// seria uma medida.
func (h Hist) Percentil(p float64) (time.Duration, bool) {
	total := h.Total()
	if total == 0 {
		return 0, false
	}
	idx := make([]int, 0, len(h))
	for i := range h {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	alvo := uint64(math.Ceil(p / 100 * float64(total)))
	if alvo == 0 {
		alvo = 1
	}
	var acc uint64
	for _, i := range idx {
		acc += h[i]
		if acc >= alvo {
			return LimiteSuperior(i), true
		}
	}
	return LimiteSuperior(idx[len(idx)-1]), true
}
