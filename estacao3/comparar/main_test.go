package main

import (
	"slices"
	"testing"
)

// A syscall que só a v2 faz é o achado principal da estação 3; ela não pode
// sumir da tabela porque a v1 não a chamou nenhuma vez.
func TestSyscallQueSoBFazEntraNaTabela(t *testing.T) {
	a := map[string]float64{"lat:p50": 11, "sys:connect": 0, "sys:socket": 0, "sys:close": 0, "sys:read": 5}
	b := map[string]float64{"lat:p50": 11.5, "sys:connect": 1, "sys:socket": 1, "sys:close": 1, "sys:read": 5, "sys:setsockopt": 5}
	r := map[string]float64{"lat:p50": 11, "sys:connect": 0, "sys:socket": 0, "sys:close": 0, "sys:read": 5.1}
	completarSyscalls(a, b, r)
	if v, ok := a["sys:setsockopt"]; !ok || v != 0 {
		t.Fatalf("A deveria ter setsockopt = 0, tem %v (%v)", v, ok)
	}
	if v, ok := r["sys:setsockopt"]; !ok || v != 0 {
		t.Fatalf("a captura de ruído deveria ter setsockopt = 0, tem %v (%v)", v, ok)
	}
	if !slices.Contains(escolherMetricas(a, b), "sys:setsockopt") {
		t.Fatalf("setsockopt ficou fora da tabela: %v", escolherMetricas(a, b))
	}
}

// Captura sem dado de syscall (coletor parado) continua sem: "não medido", nunca zero.
func TestCapturaSemSyscallsNaoGanhaZeros(t *testing.T) {
	a := map[string]float64{"lat:p50": 11}
	b := map[string]float64{"lat:p50": 11.5, "sys:connect": 1, "sys:socket": 1, "sys:close": 1, "sys:setsockopt": 5}
	completarSyscalls(a, b)
	for n := range a {
		if n != "lat:p50" {
			t.Fatalf("A ganhou %s sem ter dado de syscall", n)
		}
	}
}
