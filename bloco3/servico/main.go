// Serviço de exemplo do bloco 3. O mesmo binário tem dois papéis:
//
//	-papel estoque   responde GET /estoque/{sku}; é o serviço consultado
//	-papel api       responde GET /pedido e consulta o estoque a cada request
//
// A diferença entre as versões está só na api, na forma de falar com o estoque:
//
//	v1  reaproveita conexões: um http.Client com pool, criado uma vez
//	v2  abre uma conexão nova por request: um Transport sem keep-alive a cada chamada
//
// O estoque simula 10 ms de trabalho (o que um banco ou outro
// serviço levaria), para que o custo de uma conexão TCP nova em localhost fique
// pequeno perto da latência total, como fica num sistema real.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	papel := flag.String("papel", "api", "api ou estoque")
	versao := flag.String("versao", "v1", "v1 (pool de conexões) ou v2 (conexão nova por request); só vale para a api")
	addr := flag.String("addr", "", "endereço de escuta (padrão: 127.0.0.1:8080 na api, 127.0.0.1:8081 no estoque)")
	estoque := flag.String("estoque", "http://127.0.0.1:8081", "URL base do estoque; só vale para a api")
	trabalho := flag.Duration("trabalho", 10*time.Millisecond, "tempo que o estoque simula por request")
	pidfile := flag.String("pidfile", "", "grava o PID do processo neste arquivo")
	flag.Parse()

	if *pidfile != "" {
		if err := os.WriteFile(*pidfile, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o644); err != nil {
			log.Fatalf("gravar pidfile: %v", err)
		}
	}

	switch *papel {
	case "estoque":
		if *addr == "" {
			*addr = "127.0.0.1:8081"
		}
		log.Printf("estoque ouvindo em %s (trabalho simulado: %s)", *addr, *trabalho)
		log.Fatal(http.ListenAndServe(*addr, rotasEstoque(*trabalho)))
	case "api":
		if *addr == "" {
			*addr = "127.0.0.1:8080"
		}
		cliente, err := clientePara(*versao)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("api %s ouvindo em %s, consultando %s", *versao, *addr, *estoque)
		log.Fatal(http.ListenAndServe(*addr, rotasAPI(cliente, *estoque)))
	default:
		log.Fatalf("papel desconhecido %q: use api ou estoque", *papel)
	}
}

func rotasEstoque(trabalho time.Duration) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/estoque/", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(trabalho)
		sku := strings.TrimPrefix(r.URL.Path, "/estoque/")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"sku": sku, "quantidade": 42})
	})
	return mux
}

// cliente faz uma chamada ao estoque. As duas versões têm a mesma assinatura;
// só o que acontece com a conexão muda.
type cliente func(url string) (*http.Response, error)

func clientePara(versao string) (cliente, error) {
	switch versao {
	case "v1":
		pool := &http.Client{
			Timeout:   2 * time.Second,
			Transport: &http.Transport{MaxIdleConns: 64, MaxIdleConnsPerHost: 64, IdleConnTimeout: 90 * time.Second},
		}
		return pool.Get, nil
	case "v2":
		return func(url string) (*http.Response, error) {
			// A mudança da v2: um Transport novo, sem keep-alive, a cada chamada.
			// Cada request ao estoque faz socket(), connect() e close().
			tr := &http.Transport{DisableKeepAlives: true}
			defer tr.CloseIdleConnections()
			c := &http.Client{Timeout: 2 * time.Second, Transport: tr}
			return c.Get(url)
		}, nil
	default:
		return nil, fmt.Errorf("versão desconhecida %q: use v1 ou v2", versao)
	}
}

func rotasAPI(get cliente, estoque string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/pedido", func(w http.ResponseWriter, r *http.Request) {
		resp, err := get(estoque + "/estoque/sku-123")
		if err != nil {
			http.Error(w, "estoque indisponível: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		corpo, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != http.StatusOK {
			http.Error(w, "resposta inválida do estoque", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"pedido":"ok","estoque":%s}`, strings.TrimSpace(string(corpo)))
	})
	return mux
}
