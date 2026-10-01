// Linguagem MT — testes de modulos do Harvey pelo terminal da Area do desenvolvedor.
// Parametros definidos pelo usuario (01/10/2026). O que vale e o trecho entre [ ]; o que vier
// depois (ex.: "= open = data_base") e so comentario e e ignorado.
//
//   [m.(log(data_base))]        abre o banco de dados (resumo e ultimas mediacoes)
//   [m.(log(IA_!))]             a API da IA esta funcionando? ok / not
//   [m.(input(send_msgIA))]     abre o modo conversa com a IA no terminal ("sair" para fechar)
//   [m.(input(analyser_IA))]    teste completo de envio e resposta da IA (1 chamada ao Gemini)
//   [(test(alarm.all))]         teste completo de todos os modulos JS + alarme 'Ola'
//   [m.(test(conectors))]       todas as integracoes do codigo: ok / denied
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const banco = require('./banco');
const contas = require('./contas');
const log = require('./log');

const ok = (texto) => ({ nivel: 'ok', texto });
const falha = (texto) => ({ nivel: 'erro', texto });
const atencao = (texto) => ({ nivel: 'aviso', texto });
const info = (texto) => ({ nivel: 'info', texto });
const ms = (t0) => `${Date.now() - t0} ms`;
const STATUS = { pendente: 'pendentes', aguardando: 'aguardando o ML', auditando: 'em revisão', enviada: 'enviadas', encerrada: 'encerradas no ML' };

// "[m.(log(data_base))] = open = data_base" -> "m.(log(data_base))"
function chave(linha) {
    const m = String(linha || '').match(/\[([^\]]+)\]/);
    return m ? m[1].replace(/\s+/g, '').toLowerCase() : null;
}

// ---- [m.(log(data_base))]
function abrirBanco() {
    const L = banco.listar();
    const por = {}; for (const m of L) por[m.status] = (por[m.status] || 0) + 1;
    const arq = path.join(banco.STORAGE, 'mediacoes.json');
    let tam = 0; try { tam = fs.statSync(arq).size; } catch {}
    const out = [ok(`open = data_base · ${arq} (${(tam / 1024).toFixed(1)} KB)`),
        info(`${L.length} mediações: ${Object.entries(por).map(([k, v]) => `${v} ${STATUS[k] || k}`).join(' · ') || 'vazio'}`)];
    for (const c of Object.keys(contas.CONTAS)) out.push(info(`${contas.CONTAS[c].nome}: ${L.filter(m => m.conta === c).length}`));
    out.push(info('— últimas 8 —'));
    for (const m of L.slice(0, 8)) out.push(info(`${m.mediacao_id} · ${contas.CONTAS[m.conta]?.nome || m.conta} · ${m.prioridade} · ${STATUS[m.status] || m.status} · ${String(m.tema || '').slice(0, 50)}${m.mensagem_sugerida ? ' · resposta pronta' : ''}`));
    return out;
}

// ---- [m.(log(IA_!))]
function chaveGemini() {
    let c = '';
    try { c = (JSON.parse(fs.readFileSync(path.join(banco.STORAGE, 'config.json'), 'utf8')).gemini_api_key || '').trim(); } catch {}
    if (!c) { try { c = (fs.readFileSync('C:/Users/Matheus Prata/Desktop/tokenfgemini.txt', 'utf8').split(/\r?\n/).find(l => /^(AIza|AQ)/.test(l.trim())) || '').trim(); } catch {} }
    return c;
}
async function iaStatus() {
    const out = [];
    const k = chaveGemini();
    let t0 = Date.now();
    if (!k) out.push(falha('IA/Status · Gemini: not (sem chave)'));
    else {
        try { await axios.get('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': k }, params: { pageSize: 1 }, timeout: 15000 }); out.push(ok(`IA/Status · Gemini (análise e resposta): ok · ${ms(t0)}`)); }
        catch (e) { out.push(falha(`IA/Status · Gemini: not · ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`)); }
    }
    t0 = Date.now();
    try { await axios.get('http://127.0.0.1:11434/api/tags', { timeout: 5000 }); out.push(ok(`IA/Status · Ollama (conversa): ok · ${ms(t0)}`)); }
    catch { out.push(falha('IA/Status · Ollama (conversa): not (desligado)')); }
    return out;
}

// ---- [m.(input(analyser_IA))]: mediacao ficticia -> Gemini -> confere o JSON
async function analyserIA() {
    const ia = require('./ia');
    const ficticia = {
        mediacao_id: 'TESTE-MT', tema: 'Produto diferente ou com defeito (PDD9999)', stage: 'dispute', status_ml: 'opened',
        order_id: '0000000000', afeta_reputacao: 'not_affected', acao_disponivel: 'send_message_to_mediator',
        historico_ml: [{ remetente: 'complainant', texto: 'O tapete que chegou não encaixa no meu carro.' },
            { remetente: 'mediator', texto: 'O vendedor pode se manifestar sobre a reclamação?' }],
    };
    const t0 = Date.now();
    const out = [info('analyser_IA · enviando uma mediação de TESTE (não é do Mercado Livre, nada é salvo nem enviado)…')];
    try {
        const r = await ia.analisar(ficticia);
        out.push(ok(`envio → resposta em ${ms(t0)} · modelo ${r.modelo}`));
        for (const campo of ['resumo', 'prioridade', 'nossa_defesa', 'acao_recomendada', 'risco_reputacional', 'resposta']) {
            out.push(r[campo] ? ok(`campo "${campo}" presente`) : falha(`campo "${campo}" faltando`));
        }
        out.push(['alta', 'media', 'baixa'].includes(r.prioridade) ? ok(`prioridade válida: ${r.prioridade}`) : atencao(`prioridade fora do padrão: ${r.prioridade}`));
        out.push(info(`resposta (início): ${String(r.resposta || '').slice(0, 160).replace(/\s+/g, ' ')}…`));
    } catch (e) { out.push(falha(`analyser_IA: not · ${e.message}`)); }
    return out;
}

// ---- [m.(test(conectors))]: cada integracao do codigo
async function conectores() {
    const out = [info('alarm.conectors — integrações do Harvey')];
    const linha = (nome, okk, det) => out.push(okk ? ok(`${nome}: ok${det ? ' · ' + det : ''}`) : falha(`${nome}: denied${det ? ' · ' + det : ''}`));
    for (const c of Object.keys(contas.CONTAS)) {
        const arq = path.join(process.env.APPDATA || '', contas.CONTAS[c].app, 'storage', 'token.json');
        linha(`Dashboard ${contas.CONTAS[c].nome} (token.json)`, fs.existsSync(arq), fs.existsSync(arq) ? '' : 'arquivo não encontrado');
        let t0 = Date.now();
        try { const t = await contas.token(c); linha(`Mercado Livre OAuth ${contas.CONTAS[c].nome}`, true, `vendedor ${t.user_id} · ${ms(t0)}`); }
        catch (e) { linha(`Mercado Livre OAuth ${contas.CONTAS[c].nome}`, false, e.message); continue; }
        t0 = Date.now();
        try {
            const seller = await contas.sellerId(c);
            const { data } = await axios.get('https://api.mercadolibre.com/post-purchase/v1/claims/search', { headers: await contas.cabecalhos(c),
                params: { 'players.role': 'respondent', 'players.user_id': seller, stage: 'dispute', status: 'opened', limit: 1 }, timeout: 20000 });
            linha(`Mercado Livre Claims ${contas.CONTAS[c].nome}`, true, `${data.paging?.total ?? '?'} abertas · ${ms(t0)}`);
        } catch (e) { linha(`Mercado Livre Claims ${contas.CONTAS[c].nome}`, false, `${e.response?.status || ''} ${e.message}`); }
    }
    for (const l of await iaStatus()) out.push({ ...l, texto: l.texto.replace('IA/Status · ', '').replace(': not', ': denied') });
    let t0 = Date.now();
    try { const r = await axios.get('https://github.com/Thebigmath/mediacoes-ml-electron/releases/latest/download/latest.yml', { timeout: 15000, maxRedirects: 5 });
        const v = (String(r.data).match(/version:\s*(\S+)/) || [])[1]; linha('GitHub (atualização automática)', true, `última versão publicada ${v} · ${ms(t0)}`); }
    catch (e) { linha('GitHub (atualização automática)', false, `${e.response?.status || ''} ${e.message}`); }
    try { fs.accessSync(banco.STORAGE, fs.constants.W_OK); linha('Banco local (gravação)', true, banco.STORAGE); } catch (e) { linha('Banco local (gravação)', false, e.message); }
    return out;
}

// ---- [(test(alarm.all))]: carrega cada modulo JS, confere as funcoes e roda os testes + alarme 'Ola'
async function alarmAll(notificar) {
    const out = [info("alarm('Ola') — teste completo dos módulos JS")];
    const modulos = {
        'lib/contas.js': ['token', 'cabecalhos', 'sellerId', 'status', 'applicationId'],
        'lib/ml.js': ['sincronizar', 'enviar', 'atualizarUma'],
        'lib/ia.js': ['analisar', 'reescrever', 'conversar'],
        'lib/banco.js': ['salvarRegistro', 'salvarAnalise', 'atualizar', 'listar', 'obter', 'resumo'],
        'lib/monitor.js': ['sincronizar', 'analisarPendentes', 'enviar', 'atualizarUma', 'iniciarAgendador'],
        'lib/log.js': ['registrar', 'listar', 'explicar'],
        'lib/dev.js': ['executar'],
        'lib/mt.js': ['executar'],
        'routes/api.js': [],
    };
    for (const [arq, fns] of Object.entries(modulos)) {
        try {
            const m = require(path.join(__dirname, '..', arq));
            const faltam = fns.filter(f => typeof m[f] !== 'function');
            out.push(faltam.length ? falha(`${arq}: faltam ${faltam.join(', ')}`) : ok(`${arq}: carregado${fns.length ? ` (${fns.length} funções)` : ''}`));
        } catch (e) { out.push(falha(`${arq}: não carregou · ${e.message}`)); }
    }
    // log: grava e le de volta
    const e = log.info('dev', 'DEV_COMANDO', 'alarm.all: teste de gravação do log');
    out.push(log.listar({ desde: e.id - 1 }).some(x => x.id === e.id) ? ok('log: grava e lê') : falha('log: não leu o que gravou'));
    // banco: leitura
    try { const n = banco.listar().length; out.push(ok(`banco: leitura ok (${n} mediações)`)); } catch (er) { out.push(falha(`banco: ${er.message}`)); }
    out.push(...await conectores());
    // alarme: notificacao de teste no Windows
    try { notificar && notificar('Harvey — alarm.all', 'Ola'); out.push(ok("alarm('Ola'): notificação enviada ao Windows")); }
    catch (er) { out.push(atencao(`alarm('Ola'): ${er.message}`)); }
    const erros = out.filter(l => l.nivel === 'erro').length;
    out.push(erros ? falha(`Resultado: ${erros} falha(s)`) : ok('Resultado: todos os módulos ok'));
    return out;
}

const MT = {
    'm.(log(data_base))': { ajuda: 'open = data_base — abre o banco de dados', executar: async () => abrirBanco() },
    'm.(log(ia_!))': { ajuda: 'IA/Status — a API da IA está funcionando? ok / not', executar: iaStatus },
    'm.(input(send_msgia))': { ajuda: 'IA/msg — abre o modo conversa com a IA ("sair" para fechar)', executar: async () => [ok('IA/msg — modo conversa aberto. Escreva a mensagem (ex.: Ola). Digite "sair" para voltar.')], modo: 'ia' },
    'm.(input(analyser_ia))': { ajuda: 'analyser_IA — teste completo de envio e resposta da IA', executar: analyserIA },
    '(test(alarm.all))': { ajuda: "alarm('Ola') — teste completo de todos os módulos JS", executar: (n) => alarmAll(n) },
    'm.(test(conectors))': { ajuda: 'alarm.conectors — integrações: ok / denied', executar: conectores },
};
const NOMES = { 'm.(log(data_base))': '[m.(log(data_base))]', 'm.(log(ia_!))': '[m.(log(IA_!))]', 'm.(input(send_msgia))': '[m.(input(send_msgIA))]',
    'm.(input(analyser_ia))': '[m.(input(analyser_IA))]', '(test(alarm.all))': '[(test(alarm.all))]', 'm.(test(conectors))': '[m.(test(conectors))]' };

function ajuda() { return [info('Linguagem MT — testes de módulos'), ...Object.entries(MT).map(([k, v]) => info(`${NOMES[k].padEnd(26)} ${v.ajuda}`))]; }

async function executar(linha, notificar) {
    const k = chave(linha);
    const c = k && MT[k];
    if (!c) return { linhas: [falha(`Parâmetro MT desconhecido: ${linha}. Digite "mt" para ver a lista.`)] };
    return { linhas: await c.executar(notificar), modo: c.modo || null };
}

module.exports = { executar, chave, ajuda, MT };
