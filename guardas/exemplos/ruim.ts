// Exemplo do padrão proibido, usado pelo teste da guarda. Não é importado por nada.
declare const backend: { deploys(): Promise<unknown[]> };

export async function listarDeploys() {
  try {
    return await backend.deploys();
  } catch {
    return [];
  }
}
