// Assinante do stream do ptop: conecta no --serve, recebe os eventos e imprime
// cada mensagem como uma linha JSON, no mesmo formato do arquivo do --export.
//
// Roda sem nenhuma capability. Quem precisa de privilégio é o coletor (o ptop);
// quem lê o stream, não.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	pb "github.com/trentas/ptop/pkg/streampb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/encoding/protojson"
)

func main() {
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "uso: assinante unix:///tmp/ptop.sock")
	}
	flag.Parse()
	alvo := "unix:///tmp/ptop.sock"
	if flag.NArg() > 0 {
		alvo = flag.Arg(0)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Socket unix local, sem TLS: o próprio arquivo do socket é o controle de
	// acesso (o ptop o cria com permissão 0600).
	conn, err := grpc.NewClient(alvo, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("conectar em %s: %v", alvo, err)
	}
	defer conn.Close()

	stream, err := pb.NewEventStreamServiceClient(conn).Subscribe(ctx, &pb.SubscribeRequest{})
	if err != nil {
		log.Fatalf("assinar: %v", err)
	}
	for {
		msg, err := stream.Recv()
		if err == io.EOF || ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Fatalf("stream: %v", err)
		}
		linha, err := protojson.Marshal(msg)
		if err != nil {
			log.Fatalf("codificar: %v", err)
		}
		fmt.Println(string(linha))
	}
}
