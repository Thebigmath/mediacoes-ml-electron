# Harvey — Mediações ML

App desktop (Electron) das mediações do Mercado Livre das contas Flavia Stock e Cordeiro Car.
Mesmo molde do Dashboard ML, mas é um app separado.

- Servidor local na porta 3005; dados em `%APPDATA%\mediacoes-ml\storage`.
- Token do ML: usa o `token.json` do app Dashboard de cada conta (não guarda cópia; renova no mesmo arquivo só se vencer).
- Busca as mediações abertas (stage=dispute) a cada 30 min e avisa quando chega uma nova.
- IA: Gemini analisa e escreve a resposta (regras do Robert Alexy); Ollama local na Sala de testes.
- Enviar: só depois de confirmar na tela; confere no ML se a conta é a vendedora e se o pedido bate.
- Atualiza sozinho pelos releases deste repositório.

Publicar: subir a versão no package.json, `npx electron-builder --win --x64 --publish never`,
renomear o instalador com hífens e `gh release create vX.Y.Z <exe> <blockmap> dist/latest.yml`.
