# Linguagem MT — testes de módulos do Harvey

Usada no **terminal da Área do desenvolvedor**. O que vale é o trecho entre `[ ]`; o que vier depois
(por exemplo `= open = data_base`) é comentário e é ignorado. Maiúsculas e minúsculas tanto faz.
Digite `mt` no terminal para ver a lista.

| Parâmetro | O que faz | Resultado |
|---|---|---|
| `[m.(log(data_base))]` | **open = data_base** — abre o banco de dados: arquivo, tamanho, quantas mediações por situação e por conta, e as últimas 8 | ok + resumo |
| `[m.(log(IA_!))]` | **IA/Status** — confere se a API da IA está funcionando: Gemini (análise e resposta) e Ollama (conversa) | ok / not |
| `[m.(input(send_msgIA))]` | **IA/msg** — abre o modo conversa no terminal (o prompt vira `IA ›`). Cada linha vai para a IA e a resposta aparece embaixo. `sair` fecha | conversa |
| `[m.(input(analyser_IA))]` | **analyser_IA** — teste completo de envio e resposta: manda uma mediação **de teste** (não é do ML, nada é salvo nem enviado) para o Gemini e confere se voltaram todos os campos (resumo, prioridade, defesa, ação, risco, resposta) | ok por campo + tempo e modelo |
| `[(test(alarm.all))]` | **alarm('Ola')** — teste completo de todos os módulos JS: carrega cada arquivo e confere as funções, grava e lê um log, lê o banco, testa todas as integrações e dispara a notificação "Ola" no Windows | ok por módulo + resultado final |
| `[m.(test(conectors))]` | **alarm.conectors** — testa cada integração do código | ok / denied |

## Integrações testadas por `[m.(test(conectors))]`
- Token do app Dashboard de cada conta (`token.json` da Flavia Stock e da Cordeiro Car)
- Mercado Livre OAuth (token válido) e API de mediações (claims), por conta — só leitura
- Gemini (chave aceita) e Ollama (ligado)
- GitHub (atualização automática: última versão publicada)
- Banco local (permissão de gravação)

## Comandos simples (sem colchetes)
`ajuda`, `mt`, `status`, `contas`, `ml`, `ia`, `ollama`, `banco`, `sync`, `sync agora`, `logs [área] [qtd]`, `erros`, `versao`, `limpar`.

## Para criar um parâmetro novo
Acrescentar em `lib/mt.js`, no objeto `MT`, a chave (sem colchetes, minúsculas) com `{ ajuda, executar }`,
e o nome original em `NOMES`.
