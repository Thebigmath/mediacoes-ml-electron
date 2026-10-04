// Contas do Mercado Livre usadas pelo Harvey. Cada conta funciona em um de dois modos:
//
//   PROPRIO   -> o Harvey tem um app do ML so dele (client_id/secret em ml_apps.json) e o proprio
//                token (token_<conta>.json), tudo no storage do Harvey. Usado no PC de quem nao tem
//                o Dashboard (ex.: Ana). Nao disputa token com ninguem.
//   DASHBOARD -> sem app proprio configurado: le o token.json do app Dashboard da conta no mesmo PC
//                (mesma regra do contas.py do Jordan). O ML troca o refresh_token a cada renovacao,
//                entao so se renova quando o access_token venceu, gravando no MESMO token.json.
//
//   flavia   -> Flavia Stock  (Dashboard: %APPDATA%\dashboard-ml\storage)
//   cordeiro -> Cordeiro Car  (Dashboard: %APPDATA%\dashboard-cordeiro\storage)
//
// client_secret e tokens ficam so no %APPDATA% da maquina; nunca voltam para a tela nem vao para o log.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const log = require('./log');

const CONTAS = {
    flavia: { nome: 'Flavia Stock', app: 'dashboard-ml' },
    cordeiro: { nome: 'Cordeiro Car', app: 'dashboard-cordeiro' },
};
const MARGEM_S = 300;   // renova 5 min antes de vencer
const renovando = {};   // uma renovacao por vez por conta
// Aviso de conta desconectada: uma vez por problema (nao a cada busca) e so quando e preciso reconectar.
// Queda de internet ou erro 5xx do ML nao avisa: a proxima renovacao resolve sozinha.
let avisarDesconectada = () => {};
const avisada = {};
function usarAvisoDesconectada(fn) { avisarDesconectada = fn; }
function precisaReconectar(e) {
    const st = e.response?.status, cod = e.response?.data?.error;
    return cod === 'invalid_grant' || cod === 'invalid_client' || st === 401 || st === 400 || !e.response && /conectada|sem acesso/.test(e.message);
}
const OAUTH = 'https://api.mercadolibre.com/oauth/token';
const REDIRECT_PADRAO = 'https://claude.ai/new';   // o mesmo do Dashboard; tem de ser igual ao cadastrado no app do ML

const appdata = () => process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const pastaDashboard = (conta) => path.join(appdata(), CONTAS[conta].app, 'storage');
const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ_APPS = () => path.join(STORAGE(), 'ml_apps.json');
const arqTokenProprio = (conta) => path.join(STORAGE(), `token_${conta}.json`);
const lerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// grava em arquivo temporario e renomeia: quem le ao mesmo tempo (o Dashboard) nunca pega o arquivo pela metade
function gravarAtomico(f, obj) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 4), 'utf8');
    // no Windows a troca falha (EPERM/EBUSY) se outro programa estiver lendo o arquivo naquele instante
    for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, f); return; }
        catch (e) {
            if (i >= 9 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; }
            const ate = Date.now() + 50 * (i + 1); while (Date.now() < ate) { /* espera curta */ }
        }
    }
}

const apps = () => lerJson(ARQ_APPS()) || {};
const modo = (conta) => (apps()[conta] && apps()[conta].client_id) ? 'proprio' : 'dashboard';

function carregar(conta) {
    if (!CONTAS[conta]) throw new Error(`Conta desconhecida: ${conta}`);
    if (modo(conta) === 'proprio') {
        const cfg = apps()[conta];
        const tok = lerJson(arqTokenProprio(conta));
        if (!tok || !tok.refresh_token) throw new Error(`A conta ${CONTAS[conta].nome} ainda não foi conectada. Abra Configurações e clique em "Conectar".`);
        return { cfg, tok, arquivo: arqTokenProprio(conta) };
    }
    const cfg = lerJson(path.join(pastaDashboard(conta), 'config.json'));
    const tok = lerJson(path.join(pastaDashboard(conta), 'token.json'));
    if (!cfg || !tok || !cfg.client_id || !tok.refresh_token) {
        throw new Error(`Conta ${CONTAS[conta].nome} sem acesso: configure o app do Mercado Livre em Configurações (ou instale o Dashboard desta conta com o token gerado).`);
    }
    return { cfg, tok, arquivo: path.join(pastaDashboard(conta), 'token.json') };
}

function valido(tok) {
    if (!tok.access_token || !tok.created_at) return false;
    return Date.now() / 1000 < tok.created_at + (tok.expires_in || 21600) - MARGEM_S;
}

async function renovar(conta) {
    let { cfg, tok, arquivo } = carregar(conta);   // rele: o Dashboard pode ter acabado de renovar
    if (valido(tok)) return tok;
    const pedir = (refresh) => axios.post(OAUTH, new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.client_id,
        client_secret: cfg.client_secret, refresh_token: refresh }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 30000 });
    let data;
    try { ({ data } = await pedir(tok.refresh_token)); }
    catch (e) {
        // invalid_grant no modo Dashboard quase sempre e o Dashboard que renovou no mesmo instante:
        // rele o arquivo; se o token novo ja estiver la, usa; se o refresh mudou, tenta uma vez com ele.
        if (e.response?.data?.error !== 'invalid_grant' || modo(conta) !== 'dashboard') throw e;
        const relido = lerJson(arquivo) || {};
        if (valido(relido)) { log.info('token', 'TOKEN_DO_DASHBOARD', `${CONTAS[conta].nome}: o Dashboard renovou primeiro; usando o token dele`); return relido; }
        if (!relido.refresh_token || relido.refresh_token === tok.refresh_token) throw e;
        ({ data } = await pedir(relido.refresh_token));
    }
    const atual = lerJson(arquivo) || {};
    Object.assign(atual, data, { created_at: Math.floor(Date.now() / 1000) });
    if (!atual.user_id) atual.user_id = tok.user_id;
    gravarAtomico(arquivo, atual);
    log.info('token', 'TOKEN_RENOVADO', `${CONTAS[conta].nome}: token renovado (${modo(conta) === 'proprio' ? 'app próprio do Harvey' : 'arquivo do Dashboard'})`);
    return atual;
}

async function token(conta) {
    const { tok } = carregar(conta);
    if (valido(tok)) return { access_token: tok.access_token, user_id: String(tok.user_id || '') };
    if (!renovando[conta]) {
        renovando[conta] = renovar(conta).catch((e) => {
            log.erro('token', 'TOKEN_ERRO', `${CONTAS[conta].nome}: ${e.message}`, { http: e.response?.status || null, resposta: JSON.stringify(e.response?.data || '').slice(0, 200) });
            if (precisaReconectar(e) && !avisada[conta]) {
                avisada[conta] = true;
                log.erro('token', 'CONTA_DESCONECTADA_ML', `${CONTAS[conta].nome}: o Mercado Livre recusou a renovação. É preciso conectar a conta de novo em Configurações.`);
                try { avisarDesconectada(conta, CONTAS[conta].nome); } catch {}
            }
            throw e;
        }).finally(() => { setTimeout(() => { delete renovando[conta]; }, 0); });
    }
    const novo = await renovando[conta];
    avisada[conta] = false;   // voltou a funcionar: um problema futuro avisa de novo
    return { access_token: novo.access_token, user_id: String(novo.user_id || '') };
}

async function cabecalhos(conta) {
    const t = await token(conta);
    return { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' };
}

const cacheEu = {};
async function eu(conta) {
    if (cacheEu[conta]) return cacheEu[conta];
    const { data } = await axios.get('https://api.mercadolibre.com/users/me', { headers: await cabecalhos(conta), timeout: 30000 });
    cacheEu[conta] = data;
    return data;
}
async function sellerId(conta) {
    try { return String((await eu(conta)).id); }
    catch { return (await token(conta)).user_id; }
}

async function status(conta) {
    const m = modo(conta);
    try {
        const t = await token(conta);
        let apelido = null;
        try { apelido = (await eu(conta)).nickname; } catch {}
        return { conta, nome: CONTAS[conta].nome, modo: m, conectado: true, seller_id: t.user_id, apelido };
    } catch (e) {
        return { conta, nome: CONTAS[conta].nome, modo: m, conectado: false, erro: e.message, app_configurado: m === 'proprio' };
    }
}

// application_id (client_id do app no ML): o envio de mensagem em reclamacao exige na URL
const applicationId = (conta) => String(carregar(conta).cfg.client_id);

// ---- modo PROPRIO: configurar o app e conectar a conta (autorizacao feita uma vez pela dona da conta) ----
function configurarApp(conta, { client_id, client_secret, redirect_uri }) {
    if (!CONTAS[conta]) throw new Error('Conta desconhecida.');
    client_id = String(client_id || '').trim(); client_secret = String(client_secret || '').trim();
    if (!/^\d{6,}$/.test(client_id)) throw new Error('O App ID (client_id) do Mercado Livre é um número.');
    if (client_secret.length < 10) throw new Error('A Secret Key (client_secret) parece incompleta.');
    const a = apps();
    const mudouApp = a[conta] && a[conta].client_id !== client_id;
    a[conta] = { client_id, client_secret, redirect_uri: String(redirect_uri || '').trim() || REDIRECT_PADRAO };
    gravarAtomico(ARQ_APPS(), a);
    if (mudouApp) { try { fs.unlinkSync(arqTokenProprio(conta)); } catch {} }   // token de outro app nao serve
    delete cacheEu[conta];
    log.info('token', 'APP_ML_CONFIGURADO', `${CONTAS[conta].nome}: app próprio do ML configurado (App ID ${client_id})`);
}
function urlAutorizacao(conta) {
    const a = apps()[conta];
    if (!a || !a.client_id) throw new Error('Configure o App ID e a Secret Key desta conta primeiro.');
    return `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${a.client_id}&redirect_uri=${encodeURIComponent(a.redirect_uri)}`;
}
async function trocarCodigo(conta, codigo) {
    const a = apps()[conta];
    if (!a || !a.client_id) throw new Error('Configure o App ID e a Secret Key desta conta primeiro.');
    // aceita o code puro ou o endereco inteiro colado (…?code=TG-…)
    const m = String(codigo || '').match(/code=([^&\s]+)/);
    const code = (m ? decodeURIComponent(m[1]) : String(codigo || '')).trim();
    if (!code) throw new Error('Cole o código (code) que aparece no endereço depois de autorizar.');
    let data;
    try {
        ({ data } = await axios.post(OAUTH, new URLSearchParams({ grant_type: 'authorization_code', client_id: a.client_id,
            client_secret: a.client_secret, code, redirect_uri: a.redirect_uri }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 30000 }));
    } catch (e) {
        const d = e.response?.data || {};
        throw new Error(`O Mercado Livre recusou o código (${d.error || e.response?.status || e.message}). O código vale poucos minutos e só uma vez: autorize de novo e cole o novo.`);
    }
    const tok = { ...data, created_at: Math.floor(Date.now() / 1000) };
    const { data: me } = await axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${tok.access_token}` }, timeout: 30000 });
    tok.user_id = me.id;
    // trava contra conectar a conta errada (1): se ja se sabe qual vendedor e esta conta (token anterior
    // do proprio Harvey ou o token do Dashboard deste PC), o login tem de ser o mesmo
    const conhecido = (lerJson(arqTokenProprio(conta)) || {}).user_id || (lerJson(path.join(pastaDashboard(conta), 'token.json')) || {}).user_id;
    if (conhecido && String(conhecido) !== String(me.id)) {
        throw new Error(`Esse login é ${me.nickname} (vendedor ${me.id}), mas a ${CONTAS[conta].nome} é o vendedor ${conhecido}. Saia do Mercado Livre no navegador, entre com a conta certa e autorize de novo.`);
    }
    // trava contra conectar a conta errada (2): o mesmo vendedor nao pode ficar nas duas contas do Harvey
    for (const outra of Object.keys(CONTAS).filter(c => c !== conta)) {
        const t = lerJson(arqTokenProprio(outra));
        if (modo(outra) === 'proprio' && t && String(t.user_id) === String(me.id)) {
            throw new Error(`Esse login (${me.nickname}) já está conectado como ${CONTAS[outra].nome}. Saia do Mercado Livre no navegador e entre com a conta da ${CONTAS[conta].nome}.`);
        }
    }
    gravarAtomico(arqTokenProprio(conta), tok);
    cacheEu[conta] = me; avisada[conta] = false;
    log.info('token', 'CONTA_CONECTADA', `${CONTAS[conta].nome}: conectada como ${me.nickname} (vendedor ${me.id})`);
    return { apelido: me.nickname, seller_id: String(me.id) };
}
function desconectar(conta) {
    const a = apps(); delete a[conta]; gravarAtomico(ARQ_APPS(), a);
    try { fs.unlinkSync(arqTokenProprio(conta)); } catch {}
    delete cacheEu[conta];
    log.info('token', 'CONTA_DESCONECTADA', `${CONTAS[conta].nome}: app próprio removido`);
}
const appInfo = (conta) => { const a = apps()[conta]; return a ? { client_id: a.client_id, redirect_uri: a.redirect_uri } : null; };   // sem o secret

module.exports = { usarAvisoDesconectada, CONTAS, token, cabecalhos, sellerId, status, applicationId, modo, configurarApp, urlAutorizacao, trocarCodigo, desconectar, appInfo, REDIRECT_PADRAO };
