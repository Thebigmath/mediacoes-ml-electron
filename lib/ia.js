// Motor de resposta: analisa a mediacao e redige a resposta (Gemini, com as mesmas regras do
// projeto original do Robert Alexy). Conversa livre da Sala de Testes vai para o Ollama local.
//
// Regras: reclamacao e ALEGACAO, nao culpa; nada inventado (falta de dado vira [CONFIRMAR: ...]);
// nada de concessao nao pedida; texto que nao pareca template (o ML modera mensagem automatica).
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQUIVO_CHAVE = 'C:/Users/Matheus Prata/Desktop/tokenfgemini.txt';
const CHAVE_RE = /^(AIza|AQ)[A-Za-z0-9._\-]{30,}$/;
const OLLAMA = 'http://127.0.0.1:11434';

const SISTEMA = `Voce e o assistente juridico do Robert Alexy, advogado de defesa de vendedores em reclamacoes do Mercado Livre. Voce redige a resposta que o proprio vendedor vai ler antes de enviar.

POSTURA OBRIGATORIA
Reclamacao do comprador e ALEGACAO, nao prova. O vendedor nao e responsavel ate que a evidencia mostre o contrario. Nunca admita culpa, nunca peca desculpa pela reclamacao existir, nunca ofereca dinheiro que o vendedor nao pediu.

O QUE VOCE NAO PODE FAZER
- Inventar fato, documento, numero de pedido, prazo ou evidencia que nao esta no contexto. Se faltar dado, escreva [CONFIRMAR: ...] no corpo.
- Prometer reparo, troca ou desconto sem base no que o ML esta oferecendo.
- Usar linguagem que dispare moderacao automatica (respostas em massa, texto que parece template). Escreva como uma pessoa, com criterio.
- Mencionar que a resposta foi gerada por IA.

COMO ESCREVER
Portugues do Brasil, tom profissional e direto. Curto: ate 5 paragrafos curtos. Cite o que o comprador realmente alegou. Se o comprador nao se manifestou, diga isso explicitamente e peca a decisao do mediador.

PEDIDO QUE IMPORTA
Nao concorra com o comprador. Nao ofereca reembolso, troca, desconto ou devolucao por iniciativa propria: isso e concessao nao solicitada e enfraquece a defesa. Se o ML estiver oferecendo opcoes e uma delas for "orientar o comprador", geralmente e a melhor para o vendedor. So mencione reembolso se o historico mostrar que reembolso PARCIAL de 2 a 5 por cento resolve casos como este.

JSON ESTRITO: responda SOMENTE com o objeto JSON pedido, sem texto antes ou depois, sem bloco de codigo.`;

const SCHEMA = `Responda com este JSON exato:
{
  "resumo": "2 linhas: o que o comprador alegou e onde a reclamacao esta",
  "prioridade": "alta|media|baixa",
  "prioridade_porque": "1 linha",
  "nossa_defesa": "qual e o argumento central do vendedor",
  "provas_faltantes": ["o que precisa de [CONFIRMAR: ...] para sustentar"],
  "acao_recomendada": "responder|aguardar_comprador|aceitar_reembolso_parcial|aceitar_reembolso_total",
  "risco_reputacional": "alto|medio|baixo",
  "resposta": "o texto a enviar, pronto, em portugues do Brasil"
}`;

function config() { try { return JSON.parse(fs.readFileSync(path.join(STORAGE, 'config.json'), 'utf8')); } catch { return {}; } }

function chave() {
    const c = (config().gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
    if (c) return c;
    try {
        for (const l of fs.readFileSync(ARQUIVO_CHAVE, 'utf8').split(/\r?\n/)) if (CHAVE_RE.test(l.trim())) return l.trim();
    } catch {}
    throw new Error('Chave do Gemini não encontrada. Coloque a chave em Configurações (ou na 1ª linha de tokenfgemini.txt na Área de Trabalho).');
}
function modelos() {
    const m = config().gemini_modelos;
    return Array.isArray(m) && m.length ? m : ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
}

// Chama o Gemini com reserva entre modelos (a cota gratuita estoura rapido).
async function gerar(prompt, temperatura = 0.4, sistema = SISTEMA) {
    const k = chave();
    let ultimo = '';
    for (const modelo of modelos()) {
        for (let t = 0; t < 3; t++) {
            try {
                const { data } = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
                    systemInstruction: { parts: [{ text: sistema }] },
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: temperatura, maxOutputTokens: 2048, responseMimeType: 'application/json' },
                }, { headers: { 'x-goog-api-key': k }, timeout: 60000 });
                const texto = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
                if (texto) return { texto, modelo };
                ultimo = `${modelo}: resposta vazia`;
            } catch (e) {
                const st = e.response?.status; const msg = JSON.stringify(e.response?.data || e.message).slice(0, 160);
                ultimo = `${modelo}: ${st || ''} ${msg}`;
                if (st === 429 || /quota|RESOURCE_EXHAUSTED/i.test(msg) || st === 404) break;   // proximo modelo
                await new Promise(r => setTimeout(r, 1500 * (t + 1)));
            }
        }
    }
    throw new Error(`O Gemini não respondeu em nenhum modelo. Último erro: ${ultimo}`);
}

function json(texto) {
    const limpo = texto.trim().replace(/^```(?:json)?|```$/gm, '').trim();
    try { return JSON.parse(limpo); }
    catch { const i = limpo.indexOf('{'), j = limpo.lastIndexOf('}'); if (i >= 0 && j > i) return JSON.parse(limpo.slice(i, j + 1)); throw new Error('A IA não devolveu JSON válido.'); }
}

function contexto(m) {
    const conversa = (m.historico_ml || []).slice(-12).map(x => `[${x.remetente}] ${x.texto}`).join('\n') || '(sem mensagens)';
    return `RECLAMACAO ${m.mediacao_id}
Tema: ${m.tema}
Estagio: ${m.stage} | Status: ${m.status_ml}
Pedido: ${m.order_id} | Afeta reputacao: ${m.afeta_reputacao}
Prazo para responder: ${m.prazo_resposta || m.prazo || 'nao informado pelo ML'}
Acao liberada: ${m.acao_disponivel}

ULTIMAS MENSAGENS DA CONVERSA:
${conversa}`;
}

async function analisar(m) {
    if (!m.acao_disponivel) {
        return { erro: `A mediação ${m.mediacao_id} não aceita resposta agora (status ${m.status_ml}, estágio ${m.stage}).` };
    }
    const { texto, modelo } = await gerar(contexto(m) + '\n\n' + SCHEMA);
    const r = json(texto);
    r.prioridade = r.prioridade || 'media';
    r.resposta = r.resposta || '';
    r.modelo = modelo;
    r.analisado_em = new Date().toISOString();
    return r;
}

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

Responda apenas com: {"resposta": "..."}`);
    return { resposta: json(texto).resposta || '', modelo };
}

// Sala de Testes: conversa livre com o Llama local (Ollama).
async function conversar(mensagem, historico = []) {
    const msgs = [{ role: 'system', content: 'Voce e um assistente que ajuda o vendedor com mediacoes do Mercado Livre. Responda em portugues do Brasil, de forma clara e curta. A reclamacao do comprador e alegacao, nao prova.' },
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
}`, 0.3, SISTEMA_METRICAS);
    const r2 = json(texto);
    r2.modelo = modelo; r2.analisado_em = new Date().toISOString();
    return r2;
}

module.exports = { analisar, reescrever, conversar, analisarMetricas, TONS };
