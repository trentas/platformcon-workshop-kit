// Gerador de carga do bloco 3: chama a api numa taxa constante e mede a latência.
//
// A cada segundo, acrescenta uma linha ao log com os contadores ACUMULADOS
// (requests, erros e o histograma de latência). O make captura copia esse log
// para junto da captura do ptop, e o comparar recorta a mesma janela de tempo
// da captura: requests e latência daquele intervalo, e só dele.
//
// A cada -relatorio, escreve p50, p99, taxa e erros da janela no stdout.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/trentas/platformcon-workshop-kit/bloco3/internal/histo"
)

// Linha é uma linha do log da carga. Os campos são acumulados desde o início.
type Linha struct {
	T     int64      `json:"t"` // unix nanos
	N     uint64     `json:"n"`
	Erros uint64     `json:"erros"`
	Hist  histo.Hist `json:"hist"`
}

type medidor struct {
	mu    sync.Mutex
	n     uint64
	erros uint64
	hist  histo.Hist
}

func (m *medidor) registra(d time.Duration, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !ok {
		m.erros++
		return
	}
	m.n++
	m.hist[histo.Balde(d)]++
}

func (m *medidor) foto() Linha {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := make(histo.Hist, len(m.hist))
	for k, v := range m.hist {
		h[k] = v
	}
	return Linha{T: time.Now().UnixNano(), N: m.n, Erros: m.erros, Hist: h}
}

func main() {
	url := flag.String("url", "http://127.0.0.1:8080/pedido", "URL chamada a cada request")
	rps := flag.Int("rps", 50, "requests por segundo")
	logPath := flag.String("log", "run/carga.jsonl", "log de contadores acumulados, uma linha por segundo")
	relatorio := flag.Duration("relatorio", 10*time.Second, "intervalo do relatório no stdout")
	pidfile := flag.String("pidfile", "", "grava o PID do processo neste arquivo")
	flag.Parse()
	if *rps <= 0 {
		log.Fatal("-rps precisa ser maior que zero")
	}
	if *pidfile != "" {
		if err := os.WriteFile(*pidfile, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o644); err != nil {
			log.Fatalf("gravar pidfile: %v", err)
		}
	}

	arq, err := os.Create(*logPath)
	if err != nil {
		log.Fatalf("criar log: %v", err)
	}
	defer arq.Close()
	enc := json.NewEncoder(arq)

	m := &medidor{hist: histo.Hist{}}
	cliente := &http.Client{Timeout: 2 * time.Second}

	fmt.Printf("carga: %d req/s em %s; relatório a cada %s\n", *rps, *url, *relatorio)

	sinal := make(chan os.Signal, 1)
	signal.Notify(sinal, syscall.SIGINT, syscall.SIGTERM)

	disparo := time.NewTicker(time.Second / time.Duration(*rps))
	segundo := time.NewTicker(time.Second)
	rel := time.NewTicker(*relatorio)
	defer disparo.Stop()
	defer segundo.Stop()
	defer rel.Stop()

	anterior := m.foto()
	for {
		select {
		case <-sinal:
			_ = enc.Encode(m.foto())
			return
		case <-disparo.C:
			go func() {
				inicio := time.Now()
				resp, err := cliente.Get(*url)
				ok := err == nil && resp.StatusCode == http.StatusOK
				if resp != nil {
					_, _ = io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
				}
				m.registra(time.Since(inicio), ok)
			}()
		case <-segundo.C:
			if err := enc.Encode(m.foto()); err != nil {
				log.Printf("gravar log: %v", err)
			}
		case <-rel.C:
			atual := m.foto()
			fmt.Println(resumo(anterior, atual))
			anterior = atual
		}
	}
}

func resumo(a, b Linha) string {
	janela := b.Hist.Menos(a.Hist)
	seg := float64(b.T-a.T) / float64(time.Second)
	taxa := float64(b.N-a.N) / seg
	p50, ok50 := janela.Percentil(50)
	p99, ok99 := janela.Percentil(99)
	if !ok50 || !ok99 {
		return fmt.Sprintf("sem requests concluídos na janela · %d erros", b.Erros-a.Erros)
	}
	return virgula(fmt.Sprintf("p50 %.1f ms · p99 %.1f ms · %.0f req/s · %d erros",
		ms(p50), ms(p99), taxa, b.Erros-a.Erros))
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

func virgula(s string) string { return strings.ReplaceAll(s, ".", ",") }
