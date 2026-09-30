// Contas do Mercado Livre usadas pelo app de Mediacoes.
//
// O app NAO guarda token proprio. A fonte da verdade e o token.json do app Dashboard de
// cada conta (mesma regra do contas.py do Jordan): o ML troca o refresh_token a cada
// renovacao, entao se este app guardasse uma copia, ele e o Dashboard iam disputar o mesmo
// token e um dos dois quebraria com invalid_grant. Aqui so se renova quando o access_token
// ja venceu, e a renovacao e gravada no MESMO token.json do Dashboard.
//
//   flavia   -> Flavia Stock  (%APPDATA%\dashboard-ml\storage)
//   cordeiro -> Cordeiro Car  (%APPDATA%\dashboard-cordeiro\storage)
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONTAS = {
    flavia: { nome: 'Flavia Stock', app: 'dashboard-ml' },
    cordeiro: { nome: 'Cordeiro Car', app: 'dashboard-cordeiro' },
};
const MARGEM_S = 300;   // renova 5 min antes de vencer
const renovando = {};   // uma renovacao por vez por conta

const appdata = () => process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const pasta = (conta) => path.join(appdata(), CONTAS[conta].app, 'storage');
const lerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function carregar(conta) {
    if (!CONTAS[conta]) throw new Error(`Conta desconhecida: ${conta}`);
    const cfg = lerJson(path.join(pasta(conta), 'config.json'));
    const tok = lerJson(path.join(pasta(conta), 'token.json'));
    if (!cfg || !tok || !cfg.client_id || !tok.refresh_token) {
        throw new Error(`O app Dashboard da conta ${CONTAS[conta].nome} precisa estar instalado e com o token gerado.`);
    }
    return { cfg, tok, arquivo: path.join(pasta(conta), 'token.json') };
}

function valido(tok) {
    if (!tok.access_token || !tok.created_at) return false;
    return Date.now() / 1000 < tok.created_at + (tok.expires_in || 21600) - MARGEM_S;
}

async function token(conta) {
    let { cfg, tok, arquivo } = carregar(conta);
    if (valido(tok)) return { access_token: tok.access_token, user_id: String(tok.user_id || '') };
    if (!renovando[conta]) {
        renovando[conta] = (async () => {
            // rele antes: o Dashboard pode ter acabado de renovar
            ({ tok } = carregar(conta));
            if (valido(tok)) return tok;
            const corpo = new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.client_id,
                client_secret: cfg.client_secret, refresh_token: tok.refresh_token });
            const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', corpo.toString(),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 30000 });
            const atual = lerJson(arquivo) || {};
            Object.assign(atual, data, { created_at: Math.floor(Date.now() / 1000) });
            if (!atual.user_id) atual.user_id = tok.user_id;
            fs.writeFileSync(arquivo, JSON.stringify(atual, null, 4), 'utf8');
            return atual;
        })().finally(() => { setTimeout(() => { delete renovando[conta]; }, 0); });
    }
    const novo = await renovando[conta];
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
    try {
        const t = await token(conta);
        let apelido = null;
        try { apelido = (await eu(conta)).nickname; } catch {}
        return { conta, nome: CONTAS[conta].nome, conectado: true, seller_id: t.user_id, apelido };
    } catch (e) {
        return { conta, nome: CONTAS[conta].nome, conectado: false, erro: e.message };
    }
}

module.exports = { CONTAS, token, cabecalhos, sellerId, status };
