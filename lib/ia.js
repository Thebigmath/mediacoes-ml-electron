// Motor de resposta: analisa a mediacao e redige a resposta (Gemini, com as mesmas regras do
// projeto original do Robert Alexy). Conversa livre da Sala de Testes vai para o Ollama local.
//
// Regras: reclamacao e ALEGACAO, nao culpa; nada inventado (falta de dado vira [CONFIRMAR: ...]);
// nada de concessao nao pedida; texto que nao pareca template (o ML modera mensagem automatica).
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
// reserva so para o PC de desenvolvimento: a chave de verdade vai em Configuracoes (config.json)
const ARQUIVO_CHAVE = require('path').join(require('os').homedir(), 'Desktop', 'tokenfgemini.txt');
const CHAVE_RE = /^(AIza|AQ)[A-Za-z0-9._\-]{30,}$/;
const OLLAMA = 'http://127.0.0.1:11434';
const log = require('./log');

// ---- Contador de uso da IA (uso_ia.json: { 'AAAA-MM-DD': { gemini, ollama, erros, por_tipo } }) ----
// Base para a documentacao do periodo de testes e para acompanhar a cota do Gemini.
const ARQ_USO = path.join(STORAGE, 'uso_ia.json');
function contarUso(campo, tipo) {
    try {
        const u = (() => { try { return JSON.parse(fs.readFileSync(ARQ_USO, 'utf8')); } catch { return {}; } })();
        const dia = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);   // dia de Brasilia
        const d = (u[dia] = u[dia] || { gemini: 0, ollama: 0, erros: 0, por_tipo: {} });
        d[campo] = (d[campo] || 0) + 1;
        if (tipo && campo !== 'erros') d.por_tipo[tipo] = (d.por_tipo[tipo] || 0) + 1;
        fs.mkdirSync(STORAGE, { recursive: true });
        fs.writeFileSync(ARQ_USO, JSON.stringify(u, null, 1), 'utf8');
    } catch {}
}
function usoIA(dias = 15) {
    let u = {}; try { u = JSON.parse(fs.readFileSync(ARQ_USO, 'utf8')); } catch {}
    return Object.entries(u).sort((a, b) => b[0].localeCompare(a[0])).slice(0, dias).map(([dia, v]) => ({ dia, ...v }));
}

// ---- Manual da IA (conhecimento/MANUAL_IA.md) ----
// Regras da casa, defesas por tipo de reclamacao e exemplos de formato. Vai junto em TODA chamada
// (Gemini e Ollama), para o modelo pequeno do Ollama aprender o jeito de responder numa leitura so.
const ARQ_MANUAL = path.join(__dirname, '../conhecimento/MANUAL_IA.md');
let manualCache = { t: 0, texto: '' };
function manual() {
    try {
        const t = fs.statSync(ARQ_MANUAL).mtimeMs;
        if (t !== manualCache.t) manualCache = { t, texto: fs.readFileSync(ARQ_MANUAL, 'utf8') };
    } catch { manualCache = { t: 0, texto: '' }; }
    return manualCache.texto;
}
const comManual = (sistema) => manual() ? `${sistema}\n\n=== MANUAL DA CASA (obrigatorio) ===\n${manual()}` : sistema;

// Respostas REAIS que a equipe enviou (historico.jsonl, tipo "envio" com sucesso) para o mesmo tipo de
// reclamacao: o melhor exemplo para o modelo. As corrigidas por uma pessoa vem primeiro.
function exemplosAprovados(m, max = 2) {
    let linhas = [];
    try { linhas = fs.readFileSync(path.join(STORAGE, 'historico.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
    const banco = require('./banco');
    const codigo = (t) => (String(t || '').match(/\(([A-Z]{3})/) || [])[1] || '';
    const alvo = codigo(m.tema);
    const ex = [];
    for (const l of linhas.reverse()) {
        let h; try { h = JSON.parse(l); } catch { continue; }
        if (h.tipo !== 'envio' || !h.enviou || !h.texto || h.mediacao_id === m.mediacao_id) continue;
        const outra = banco.obter(h.mediacao_id);
        if (!outra || (alvo && codigo(outra.tema) !== alvo)) continue;
        ex.push({ tema: outra.tema, estagio: outra.stage, alegacao: String(outra.pergunta_original || '').slice(0, 300), resposta: String(h.texto).slice(0, 700), editada: !!h.editada });
    }
    return ex.sort((a, b) => b.editada - a.editada).slice(0, max);
}

// ---- Reserva local: Ollama, quando o Gemini nao responde (sem internet, cota, sem chave) ----
const OLLAMA_CTX = 8192;   // o manual + a conversa nao cabem no padrao de 2048 do Ollama
async function ollamaLigado() { try { await axios.get(`${OLLAMA}/api/tags`, { timeout: 3000 }); return true; } catch { return false; } }
async function gerarOllama(prompt, temperatura, sistema) {
    const modelo = config().ollama_modelo || 'llama3.2';
    const { data } = await axios.post(`${OLLAMA}/api/chat`, {
        model: modelo, stream: false, format: 'json',
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: prompt }],
        options: { temperature: temperatura, num_ctx: OLLAMA_CTX, num_predict: 1200 },
    }, { timeout: 300000 });
    const texto = data?.message?.content || '';
    if (!texto) throw new Error('o Ollama respondeu vazio');
    return { texto, modelo: `ollama:${modelo}` };
}

const SISTEMA = `Voce e o assistente juridico do Robert Alexy, advogado de defesa de vendedores em reclamacoes do Mercado Livre. Voce redige a resposta que o proprio vendedor vai ler antes de enviar.

POSTURA OBRIGATORIA
Reclamacao do comprador e ALEGACAO, nao prova. O vendedor nao e responsavel ate que a evidencia mostre o contrario. Nunca admita culpa, nunca peca desculpa pela reclamacao existir, nunca ofereca dinheiro que o vendedor nao pediu.

O QUE VOCE NAO PODE FAZER
- Inventar fato, documento, numero de pedido, prazo ou evidencia que nao esta no contexto. Se faltar dado, escreva [CONFIRMAR: ...] no corpo.
- Prometer reparo, troca ou desconto sem base no que o ML esta oferecendo.
- Usar linguagem que dispare moderacao automatica (respostas em massa, texto que parece template). Escreva como uma pessoa, com criterio.
- Mencionar que a resposta foi gerada por IA.
- Falar, pedir, adivinhar ou comentar qualquer senha, chave ou credencial do app, em nenhuma hipotese.

COMO ESCREVER
Portugues do Brasil, DIRETO E SIMPLES, sem formalidade: nada de 'Prezado', 'Tomamos ciencia', 'Destacamos', 'Salientamos', 'Informamos'. Comece com 'Olá.' e use 2 a 4 frases curtas. Cite o que o comprador realmente alegou. Se o comprador nao se manifestou, diga isso explicitamente e peca a decisao do mediador.

PEDIDO QUE IMPORTA
Nao concorra com o comprador. Nao ofereca reembolso, troca, desconto ou devolucao por iniciativa propria: isso e concessao nao solicitada e enfraquece a defesa. Se o ML estiver oferecendo opcoes e uma delas for "orientar o comprador", geralmente e a melhor para o vendedor. So mencione reembolso se o historico mostrar que reembolso PARCIAL de 2 a 5 por cento resolve casos como este.

JSON ESTRITO: responda SOMENTE com o objeto JSON pedido, sem texto antes ou depois, sem bloco de codigo.`;

const SCHEMA = `Responda com este JSON exato:
{
  "resumo": "2 linhas: o que o comprador alegou e onde a reclamacao esta",
  "prioridade": "alta|media|baixa",
  "prioridade_porque": "1 linha",
  "nossa_defesa": "a tese aplicada a este caso em 1 frase: o que e alegado, qual evidencia nossa existe e qual evidencia falta ao comprador",
  "provas_faltantes": ["o que precisa de [CONFIRMAR: ...] para sustentar"],
  "acao_recomendada": "responder|aguardar_comprador|aceitar_reembolso_parcial|aceitar_reembolso_total",
  "risco_reputacional": "alto|medio|baixo",
  "fotos": "o que as fotos anexadas mostram, 1 a 2 frases objetivas (vazio se nao houver fotos)",
  "resposta": "o texto a enviar: DIRETO, 2 a 4 frases curtas, como alguem da loja falando. Jeito certo (so o tom, nao copie): 'Olá. O comprador diz que X, mas Y. Ele ainda nao mandou Z. Pedimos que o caso seja decidido pelas provas.' Proibido: Prezado, Tomamos ciencia, Ressaltando/Ressaltamos, Destacamos, Salientamos, Informamos, Solicitamos que, Vimos por meio desta, Atenciosamente, devida conferencia, conforme os procedimentos."
}`;

function config() { try { return JSON.parse(fs.readFileSync(path.join(STORAGE, 'config.json'), 'utf8')); } catch { return {}; } }

function chave() {
    const c = (config().gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
    if (c) return c;
    try {
        for (const l of fs.readFileSync(ARQUIVO_CHAVE, 'utf8').split(/\r?\n/)) if (CHAVE_RE.test(l.trim())) return l.trim();
    } catch {}
    throw new Error('Chave do Gemini não encontrada. Coloque a chave em Configurações > Chave do Gemini e clique em Salvar.');
}
function modelos() {
    const m = config().gemini_modelos;
    return Array.isArray(m) && m.length ? m : ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
}

// Chama o Gemini com reserva entre modelos (a cota gratuita estoura rapido).
async function gerar(prompt, temperatura = 0.4, sistema = SISTEMA, tipo = 'outro', imagens = []) {
    sistema = comManual(sistema);
    let k = null, ultimo = '';
    try { k = chave(); } catch (e) { ultimo = e.message; }
    for (const modelo of k ? modelos() : []) {
        for (let t = 0; t < 3; t++) {
            try {
                const { data } = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
                    systemInstruction: { parts: [{ text: sistema }] },
                    contents: [{ role: 'user', parts: [{ text: prompt }, ...imagens.map(i => ({ inline_data: { mime_type: i.tipo, data: i.base64 } }))] }],
                    generationConfig: { temperature: temperatura, maxOutputTokens: 2048, responseMimeType: 'application/json' },
                }, { headers: { 'x-goog-api-key': k }, timeout: 60000 });
                const texto = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
                if (texto) { contarUso('gemini', tipo); return { texto, modelo }; }
                ultimo = `${modelo}: resposta vazia`;
            } catch (e) {
                const st = e.response?.status; const msg = JSON.stringify(e.response?.data || e.message).slice(0, 160);
                ultimo = `${modelo}: ${st || ''} ${msg}`;
                if (st === 429 || /quota|RESOURCE_EXHAUSTED/i.test(msg) || st === 404) break;   // proximo modelo
                await new Promise(r => setTimeout(r, 1500 * (t + 1)));
            }
        }
    }
    if (await ollamaLigado()) {
        log.aviso('ia', 'IA_RESERVA_OLLAMA', `Gemini indisponível (${ultimo.slice(0, 120)}); usando o Ollama local`);
        try { const r = await gerarOllama(prompt, temperatura, sistema); contarUso('ollama', tipo); return r; }
        catch (e) { ultimo += ` | Ollama: ${e.message}`; }
    }
    contarUso('erros', tipo);
    throw new Error(`Nenhuma IA respondeu (Gemini e reserva local). Último erro: ${ultimo}`);
}

function json(texto) {
    const limpo = texto.trim().replace(/^```(?:json)?|```$/gm, '').trim();
    try { return JSON.parse(limpo); }
    catch { const i = limpo.indexOf('{'), j = limpo.lastIndexOf('}'); if (i >= 0 && j > i) return JSON.parse(limpo.slice(i, j + 1)); throw new Error('A IA não devolveu JSON válido.'); }
}

function contexto(m) {
    const conversa = (m.historico_ml || []).slice(-12).map(x => `[${x.remetente}] ${x.texto}`).join('\n') || '(sem mensagens)';
    const para = m.destinatario === 'mediator' || m.stage === 'dispute' ? 'o MEDIADOR do Mercado Livre (escreva para ele, fale do comprador em 3a pessoa)'
        : 'o COMPRADOR (escreva para ele, cordial)';
    return `SUA RESPOSTA VAI PARA: ${para}
RECLAMACAO ${m.mediacao_id}
Tema: ${m.tema}
Estagio: ${m.stage} | Status: ${m.status_ml}
Pedido: ${m.order_id} | Afeta reputacao: ${m.afeta_reputacao}
Prazo para responder: ${m.prazo_resposta || m.prazo || 'nao informado pelo ML'}
Acao liberada: ${m.acao_disponivel}

O QUE O COMPRADOR ALEGOU (registro do Mercado Livre): ${m.alegacao || m.pergunta_original || 'nao informado'}
SITUACAO NO ML: ${[m.situacao, m.situacao_detalhe].filter(Boolean).join(' - ') || 'nao informada'}
QUEM DEVE AGIR AGORA: ${m.quem_age === 'complainant' ? 'o comprador' : m.quem_age === 'respondent' ? 'NOS (vendedor)' : m.quem_age === 'mediator' ? 'o mediador' : (m.quem_age || 'nao informado')}
DEVOLUCAO: ${m.devolucao ? `status ${m.devolucao.status || '-'}, envio ${m.devolucao.envio || '-'}, produto volta para ${m.devolucao.destino === 'warehouse' ? 'o centro de distribuicao do ML (Full)' : m.devolucao.destino === 'seller_address' ? 'o vendedor' : (m.devolucao.destino || '-')}` : 'sem devolucao aberta'}
(Na mediacao o vendedor nao ve as mensagens do comprador: use a alegacao acima como o que ele disse.)

ULTIMAS MENSAGENS DA CONVERSA (mediador e vendedor):
${conversa}`;
}

async function analisar(m, extras = {}) {
    if (!m.acao_disponivel) {
        return { erro: `A mediação ${m.mediacao_id} não aceita resposta agora (status ${m.status_ml}, estágio ${m.stage}).` };
    }
    const ex = exemplosAprovados(m);
    const blocoEx = ex.length ? '\n\nRESPOSTAS REAIS JA ENVIADAS PELA EQUIPE EM CASOS DO MESMO TIPO (siga o estilo, nunca copie os fatos):\n'
        + ex.map((e, i) => `${i + 1}) [${e.tema} | ${e.estagio}${e.editada ? ' | corrigida pela equipe' : ''}] Alegacao: ${e.alegacao}\nResposta enviada: ${e.resposta}`).join('\n\n') : '';
    const fotos = (extras && extras.fotos) || [];
    const blocoFotos = fotos.length ? `\n\nFOTOS ANEXADAS NA CONVERSA (${fotos.length}, enviadas por: ${fotos.map(f => f.de === 'respondent' ? 'nos' : f.de === 'mediator' ? 'mediador (normalmente encaminhando o comprador)' : 'comprador').join(', ')}):
Olhe as fotos. Descreva em "fotos" o que elas mostram de fato (produto, dano, embalagem). Use como evidencia:
- se a foto NAO mostra o dano alegado, diga isso na resposta (a alegacao segue sem prova);
- se a foto MOSTRA o dano, nao negue: defenda pelo transporte do ML, instalacao por terceiro ou orientacao, conforme o caso;
- nunca afirme algo que nao da para ver.` : '';
    const { texto, modelo } = await gerar(contexto(m) + blocoEx + blocoFotos + '\n\n' + SCHEMA, 0.4, SISTEMA, 'mediacao', fotos);
    const r = json(texto);
    r.prioridade = r.prioridade || 'media';
    r.resposta = r.resposta || '';
    // Trava de tom: se escapou expressao formal, pede uma reescrita direta (1 chamada a mais, so quando precisa)
    if (FORMAL.test(r.resposta)) {
        try {
            const { texto: t2 } = await gerar(`Reescreva a mensagem abaixo DIRETA e SIMPLES, como alguem da loja falando, 2 a 4 frases curtas, comecando com "Olá.".
Mantenha exatamente os mesmos fatos e o mesmo pedido. Tire toda formalidade: ${FORMAL_LISTA}.

MENSAGEM:
${r.resposta}

Responda apenas com: {"resposta": "..."}`, 0.3, SISTEMA, 'mediacao_tom');
            const n = String(json(t2).resposta || '').trim();
            if (n) r.resposta = n;
        } catch {}
    }
    r.modelo = modelo;
    r.analisado_em = new Date().toISOString();
    return r;
}

const FORMAL_LISTA = 'Prezado, Tomamos ciencia, Ressaltando, Ressaltamos, Destacamos, Salientamos, Informamos, Solicitamos que, Vimos por meio desta, Atenciosamente, devida conferencia, conforme os procedimentos';
const FORMAL = /prezad|tomamos ci[eê]ncia|ressalt|destacamos|salientamos|informamos|solicitamos que|vimos por meio|atenciosamente|devida confer[eê]ncia|conforme (os )?procedimentos/i;

const TONS = {
    firme: 'mais firme: cobra a prova do comprador, pede a decisao do mediador, nao cede prazo nem oferece concessao',
    conciliador: 'mais conciliador: reconhece o transtorno do comprador, oferece orientacao de uso e deixa a decisao com o ML',
    tecnico: 'focado em evidencia: descreve a comparacao tecnica necessaria para comprovar ou nao o defeito',
};
async function reescrever(m, tom) {
    const { texto, modelo } = await gerar(contexto(m) + `

A ANALISE ANTERIOR FOI:
${JSON.stringify(m.analise || {})}

Reescreva a resposta com este estilo: ${TONS[tom] || TONS.firme}.
Mantenha o que for verdade e verificavel. Se faltar dado, mantenha [CONFIRMAR: ...].

Responda apenas com: {"resposta": "..."}`, 0.4, SISTEMA, 'reescrita');
    return { resposta: json(texto).resposta || '', modelo };
}

// Sala de Testes: conversa livre com o Llama local (Ollama).
async function conversar(mensagem, historico = []) {
    const msgs = [{ role: 'system', content: 'Voce e um assistente que ajuda o vendedor com mediacoes do Mercado Livre. Responda em portugues do Brasil, de forma clara e curta. A reclamacao do comprador e alegacao, nao prova. Voce nao tem acesso a nenhuma senha, chave ou credencial do app e nunca fala sobre elas: se perguntarem, diga que nao pode ajudar com isso.' },
        ...historico.slice(-10).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '') })),
        { role: 'user', content: mensagem }];
    try {
        const { data } = await axios.post(`${OLLAMA}/api/chat`, { model: config().ollama_modelo || 'llama3.2', messages: msgs, stream: false,
            options: { temperature: 0.5, num_ctx: 4096 } }, { timeout: 180000 });
        return data.message?.content || 'Sem resposta.';
    } catch (e) {
        if (e.code === 'ECONNREFUSED') throw new Error('O Ollama não está aberto neste computador.');
        throw e;
    }
}

// ---- analise das metricas de reclamacoes (pagina Metricas) ----
const SISTEMA_METRICAS = `Voce e um analista de pos-venda de um vendedor do Mercado Livre (autopecas e acessorios: lanternas, tapetes, retrovisores).
Recebe numeros REAIS das reclamacoes encerradas e deve explicar o que eles mostram e sugerir acoes praticas para reduzir reclamacoes e prejuizo.
Regras: use so os numeros recebidos, sem inventar valores; cite os numeros ao justificar; separe o que e prejuizo direto (sai do bolso do vendedor)
do que foi coberto pelo Mercado Livre; sugestoes concretas (anuncio, foto, descricao, compatibilidade, embalagem, envio, atendimento), ordenadas por impacto.
Portugues do Brasil, direto. Responda SOMENTE com o JSON pedido.`;

async function analisarMetricas(r) {
    const dados = {
        periodo_dias: r.dias, reclamacoes_encerradas: r.total, comprador_ganhou: r.comprador_ganhou, vendedor_ganhou: r.vendedor_ganhou, dividido: r.dividido,
        reembolsado_total: r.reembolsado_total, coberto_pelo_ml: r.coberto_ml, prejuizo_direto: r.prejuizo_direto,
        por_conta: r.por_conta, por_tipo: r.por_tipo.map(x => ({ tipo: x.nome, qtd: x.qtd, comprador_ganhou: x.comprador_ganhou })),
        principais_motivos: r.motivos.slice(0, 10).map(x => ({ motivo: x.nome, grupo: x.tipo, qtd: x.qtd, comprador_ganhou: x.comprador_ganhou, prejuizo_direto: x.prejuizo })),
        produtos_com_mais_reclamacoes: r.produtos.slice(0, 10).map(x => ({ produto: x.titulo, qtd: x.qtd, reembolsado: x.reembolsado, prejuizo_direto: x.prejuizo })),
        resolucoes: r.por_resolucao.slice(0, 8).map(x => ({ resolucao: x.nome, qtd: x.qtd })),
    };
    const { texto, modelo } = await gerar(`NUMEROS DAS RECLAMACOES:
${JSON.stringify(dados)}

Responda com este JSON exato:
{
  "resumo": "3 a 4 linhas: o quadro geral, com os numeros",
  "prejuizo": "1 a 2 linhas: quanto foi prejuizo direto e quanto o ML cobriu, e o que isso significa",
  "principais_causas": [{"causa": "...", "porque": "1 linha com o numero"}],
  "sugestoes": [{"titulo": "acao curta", "detalhe": "o que fazer, na pratica", "impacto": "alto|medio|baixo", "relacionado": "motivo ou produto"}],
  "alertas": ["o que merece atencao imediata"]
}`, 0.3, SISTEMA_METRICAS, 'metricas');
    const r2 = json(texto);
    r2.modelo = modelo; r2.analisado_em = new Date().toISOString();
    return r2;
}

// ---- perguntas de pre-venda ----
const SISTEMA_PERGUNTAS = `Voce responde perguntas de compradores num anuncio do Mercado Livre, em nome do vendedor (autopecas e acessorios).
REGRAS:
- Use SOMENTE os dados do anuncio recebidos (titulo, atributos, descricao, estoque, frete, garantia, variacoes) e as respostas que o vendedor ja deu no mesmo anuncio. Nunca invente compatibilidade, medida, prazo, estoque ou caracteristica.
- Compatibilidade com veiculo: so confirme se o modelo e o ano estiverem no titulo, na descricao ou nos atributos. Se nao estiver claro, nao confirme.
- Nunca passe telefone, e-mail, redes sociais nem peca para falar fora do Mercado Livre (o ML proibe). Link SO dos nossos anuncios da lista do catalogo.
- Nao prometa desconto, brinde, troca ou prazo que nao esteja no anuncio. Nao fale de senhas ou credenciais.
- Portugues do Brasil, cordial e curto (1 a 3 frases). Comece com "Olá!" e termine agradecendo, no tom das respostas anteriores do vendedor.
- Seja DIRETO: responda o que foi perguntado na 1a frase, sem enrolar. Siga o tom das RESPOSTAS REVISADAS PELA EQUIPE (quando vierem).
- ESTOQUE: se o estoque do anuncio (ou da variacao pedida) for 0, diga que esta sem estoque no momento.
- CATALOGO: alem deste anuncio voce recebe OUTROS ANUNCIOS NOSSOS encontrados para o que o comprador pediu (outro lado, outro carro, outra versao).
  * Se o comprador pede algo que NAO e este anuncio e existe um anuncio nosso com estoque > 0 que atende, indique esse anuncio e cole o LINK dele exatamente como veio (so links da lista; nunca invente link).
  * Se o que ele pediu (outro carro/modelo/lado) NAO aparece no catalogo, responda direto que nao temos (ex.: "Olá! Não temos para o Peugeot 208 no momento. Obrigado!").
  * Se o catalogo nao foi pesquisado (lista ausente), nao afirme que nao temos: diga que vai confirmar e marque precisa_humano = true.
- confianca "alta" SO quando a resposta esta claramente nos dados. Se faltar dado, se for reclamacao, negociacao de preco, pedido de produto que nao e do anuncio, ou algo que exija o vendedor: precisa_humano = true.
Responda SOMENTE com o JSON pedido.`;

// 1o passo das perguntas: o que o comprador quer (para buscar no NOSSO catalogo). Chamada curta.
async function entenderPergunta(pergunta, tituloAnuncio) {
    const { texto } = await gerar(`ANUNCIO ONDE A PERGUNTA FOI FEITA: "${tituloAnuncio}"
PERGUNTA: "${String(pergunta).slice(0, 600)}"

O comprador pede algo DIFERENTE deste anuncio (outro carro, outro modelo, outro ano, o outro lado, outra cor/versao)?
Responda com este JSON exato:
{"pede_outro": true|false, "busca": "3 a 5 palavras para buscar no catalogo do vendedor: tipo do produto + marca/modelo do carro + lado se houver (ex.: 'tapete peugeot 208', 'lanterna strada esquerdo'); vazio se pede_outro=false", "o_que": "o que ele quer em poucas palavras"}`, 0.1,
        'Voce extrai a intencao de perguntas de compradores do Mercado Livre (autopecas). Responda SOMENTE com o JSON pedido.', 'pergunta_intencao');
    const r = json(texto);
    return { pede_outro: !!r.pede_outro, busca: String(r.busca || '').trim().slice(0, 80), o_que: String(r.o_que || '').slice(0, 120) };
}

async function responderPergunta(pergunta, p, extras = {}) {
    const dados = { titulo: p.titulo, preco: p.preco, estoque: p.estoque, condicao: p.condicao, frete_gratis: p.frete_gratis, enviado_pelo_full: p.full,
        garantia: p.garantia, atributos: p.atributos, variacoes: p.variacoes, descricao: p.descricao, respostas_anteriores_do_vendedor: p.anteriores };
    const cat = extras.catalogo;
    const blocoCat = !cat ? '\n\nOUTROS ANUNCIOS NOSSOS: (catalogo nao pesquisado)'
        : `\n\nO COMPRADOR PEDE: ${cat.o_que || '-'} | BUSCA FEITA NO NOSSO CATALOGO: "${cat.busca}"\nOUTROS ANUNCIOS NOSSOS ENCONTRADOS: ${cat.itens.length ? JSON.stringify(cat.itens) : 'NENHUM (nao vendemos isso)'}`;
    const blocoEstilo = (extras.estilo || []).length
        ? `\n\nRESPOSTAS REVISADAS PELA EQUIPE (siga este tom, curto e direto):\n${extras.estilo.map(e => `P: ${e.p}\nR: ${e.r}`).join('\n')}` : '';
    const { texto, modelo } = await gerar(`DADOS DO ANUNCIO:
${JSON.stringify(dados)}${blocoCat}${blocoEstilo}

PERGUNTA DO COMPRADOR: "${String(pergunta).slice(0, 1000)}"

Responda com este JSON exato:
{"resposta": "texto pronto para enviar", "confianca": "alta|media|baixa", "precisa_humano": true|false, "motivo": "1 linha: por que tem ou nao tem certeza", "base": "de onde veio a informacao (titulo, descricao, atributo...)", "trecho": "COPIE EXATAMENTE, letra por letra, o trecho dos DADOS DO ANUNCIO que comprova a resposta (vazio se a resposta vem do catalogo ou se nao ha trecho)"}`, 0.2, SISTEMA_PERGUNTAS, 'pergunta');
    const r = json(texto);
    return { resposta: String(r.resposta || '').trim(), confianca: ['alta', 'media', 'baixa'].includes(r.confianca) ? r.confianca : 'baixa',
        precisa_humano: r.precisa_humano !== false, motivo: r.motivo || '', base: r.base || '', trecho: String(r.trecho || '').trim(), modelo };
}

module.exports = { chave, usoIA, analisar, reescrever, conversar, analisarMetricas, responderPergunta, entenderPergunta, TONS };
