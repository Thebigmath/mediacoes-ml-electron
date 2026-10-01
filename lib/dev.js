// Terminal da Area do desenvolvedor. Cada comando testa uma parte do app e devolve linhas
// com o resultado ({ nivel: 'ok'|'erro'|'aviso'|'info', texto }).
// Para criar um comando novo: acrescente em COMANDOS { ajuda, executar(args) }.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const contas = require('./contas');
const banco = require('./banco');
const monitor = require('./monitor');
const log = require('./log');

const ok = (texto) => ({ nivel: 'ok', texto });
const falha = (texto) => ({ nivel: 'erro', texto });
const atencao = (texto) => ({ nivel: 'aviso', texto });
const info = (texto) => ({ nivel: 'info', texto });
const ms = (t0) => `${Date.now() - t0} ms`;
const quando = (d) => d ? new Date(d).toLocaleString('pt-BR') : '—';

function config() { try { return JSON.parse(fs.readFileSync(path.join(banco.STORAGE, 'config.json'), 'utf8')); } catch { return {}; } }

async function testarContas() {
    const L = [];
    for (const c of Object.keys(contas.CONTAS)) {
        const t0 = Date.now();
        try {
            const t = await contas.token(c);
            L.push(ok(`${contas.CONTAS[c].nome}: token válido (vendedor ${t.user_id}) · ${ms(t0)}`));
        } catch (e) { L.push(falha(`${contas.CONTAS[c].nome}: ${e.message}`)); }
    }
    return L;
}
async function testarML() {
    const L = [];
    for (const c of Object.keys(contas.CONTAS)) {
        const t0 = Date.now();
        try {
            const seller = await contas.sellerId(c);
            const { data } = await axios.get('https://api.mercadolibre.com/post-purchase/v1/claims/search',
                { headers: await contas.cabecalhos(c), params: { 'players.role': 'respondent', 'players.user_id': seller, stage: 'dispute', status: 'opened', limit: 1 }, timeout: 30000 });
            L.push(ok(`${contas.CONTAS[c].nome}: API de mediações respondendo (${data.paging?.total ?? '?'} abertas) · ${ms(t0)}`));
        } catch (e) { L.push(falha(`${contas.CONTAS[c].nome}: ${e.response?.status || ''} ${e.message}`)); }
    }
    return L;
}
async function testarGemini() {
    const t0 = Date.now();
    let chave = (config().gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
    if (!chave) { try { chave = (fs.readFileSync('C:/Users/Matheus Prata/Desktop/tokenfgemini.txt', 'utf8').split(/\r?\n/).find(l => /^(AIza|AQ)/.test(l.trim())) || '').trim(); } catch {} }
    if (!chave) return [falha('Gemini: sem chave (Configurações ou tokenfgemini.txt).')];
    try {
        // lista os modelos: confere a chave sem gastar cota de geração
        const { data } = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': chave }, params: { pageSize: 50 }, timeout: 20000 });
        const nomes = (data.models || []).map(m => m.name.replace('models/', ''));
        const usados = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
        const disp = usados.filter(u => nomes.includes(u));
        return [ok(`Gemini: chave aceita · ${ms(t0)}`), disp.length ? ok(`Modelos usados disponíveis: ${disp.join(', ')}`) : atencao('Nenhum dos modelos usados pelo app apareceu na lista da chave.')];
    } catch (e) { return [falha(`Gemini: ${e.response?.status || ''} ${JSON.stringify(e.response?.data?.error?.message || e.message).slice(0, 160)}`)]; }
}
async function testarOllama() {
    const t0 = Date.now();
    try {
        const { data } = await axios.get('http://127.0.0.1:11434/api/tags', { timeout: 5000 });
        const nomes = (data.models || []).map(m => m.name);
        return [ok(`Ollama: ligado · ${ms(t0)}`), info(`Modelos: ${nomes.join(', ') || 'nenhum'}`)];
    } catch { return [atencao('Ollama: desligado (só a conversa livre depende dele).')]; }
}
function testarBanco() {
    const L = banco.listar();
    const por = {}; for (const m of L) por[m.status] = (por[m.status] || 0) + 1;
    const semResp = L.filter(m => m.status === 'pendente' && !m.mensagem_sugerida).length;
    const linhas = [ok(`Banco: ${L.length} mediações salvas em ${banco.STORAGE}`), info(`Por situação: ${Object.entries(por).map(([k, v]) => `${k} ${v}`).join(' · ') || 'vazio'}`)];
    linhas.push(semResp ? atencao(`${semResp} pendente(s) ainda sem resposta da IA`) : ok('Todas as pendentes têm resposta pronta'));
    return linhas;
}
function testarSync() {
    const e = monitor.estado;
    const L = [e.rodando ? info(`Busca em andamento: ${e.etapa}`) : ok('Nenhuma busca rodando agora')];
    for (const [c, u] of Object.entries(e.ultimo)) L.push(info(`${contas.CONTAS[c].nome}: última busca ${quando(u.quando)} · ${u.abertas} abertas`));
    if (!Object.keys(e.ultimo).length) L.push(atencao('Ainda não houve busca desde que o app abriu.'));
    for (const x of e.erros || []) L.push(falha(x));
    return L;
}

const COMANDOS = {
    ajuda: { ajuda: 'lista os comandos', executar: () => Object.entries(COMANDOS).map(([k, v]) => info(`${k.padEnd(10)} ${v.ajuda}`)) },
    status: { ajuda: 'testa todas as áreas de uma vez', executar: async () => [
        info('— contas e token —'), ...await testarContas(), info('— Mercado Livre —'), ...await testarML(),
        info('— IA —'), ...await testarGemini(), ...await testarOllama(), info('— banco —'), ...testarBanco(), info('— busca automática —'), ...testarSync()] },
    contas: { ajuda: 'token do ML de cada conta (lido do app Dashboard)', executar: testarContas },
    ml: { ajuda: 'API de mediações do Mercado Livre (só leitura)', executar: testarML },
    ia: { ajuda: 'chave do Gemini e modelos (sem gastar cota)', executar: testarGemini },
    ollama: { ajuda: 'Llama local (Ollama)', executar: testarOllama },
    banco: { ajuda: 'mediações salvas no app', executar: testarBanco },
    sync: { ajuda: 'situação da busca automática (use "sync agora" para buscar)', executar: async (args) => {
        if (args[0] === 'agora') { monitor.sincronizar().catch(() => {}); return [ok('Busca iniciada. Acompanhe nos logs (área sync).')]; }
        return testarSync();
    } },
    logs: { ajuda: 'últimos logs: logs [área] [quantidade]  ex.: logs ia 20', executar: (args) => {
        const area = args[0] && !/^\d+$/.test(args[0]) ? args[0] : undefined;
        const n = Number(args.find(a => /^\d+$/.test(a))) || 15;
        const L = log.listar({ area, limite: n });
        return L.length ? L.map(e => ({ nivel: e.nivel === 'info' ? 'info' : e.nivel, texto: `${quando(e.quando)} [${e.area}] ${e.codigo} — ${e.mensagem}` })) : [info('Sem logs.')];
    } },
    erros: { ajuda: 'só os erros recentes', executar: () => { const L = log.listar({ nivel: 'erro', limite: 20 }); return L.length ? L.map(e => falha(`${quando(e.quando)} [${e.area}] ${e.codigo} — ${e.mensagem}`)) : [ok('Nenhum erro registrado.')]; } },
    versao: { ajuda: 'versão do app', executar: () => [info(`Mediações ML v${require('../package.json').version}`)] },
};

async function executar(linha) {
    const partes = String(linha || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return [];
    const [cmd, ...args] = partes;
    const c = COMANDOS[cmd.toLowerCase()];
    log.info('dev', 'DEV_COMANDO', linha);
    if (!c) return [falha(`Comando desconhecido: ${cmd}. Digite "ajuda".`)];
    try { return await c.executar(args); } catch (e) { return [falha(`${cmd}: ${e.message}`)]; }
}

module.exports = { executar, COMANDOS };
