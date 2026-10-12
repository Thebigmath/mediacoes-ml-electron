// Sinal de reputacao (trazido do Dashboard em 12/10/2026): le a reputacao das DUAS contas a cada 4 min
// (/users/me -> seller_reputation) e compara as taxas de 60 dias com os limites do MercadoLider:
// reclamacoes 1%, cancelamentos 1%, atraso no envio 5%. Passou de 75% do limite = a conta esta a
// caminho de perder o Platinum: faixa vermelha no Harvey, aviso no Windows e beep (a cada 6 h no maximo).
// Arquivos: STORAGE/reputacao.json (ultimo estado por conta) e reputacao_config.json (limites).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const contas = require('./contas');
const log = require('./log');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'reputacao.json');
const ARQ_CFG = path.join(STORAGE, 'reputacao_config.json');
const PRIMEIRA_MS = 30 * 1000;
const INTERVALO_MS = 4 * 60 * 1000;
const REAVISAR_MS = 6 * 3600 * 1000;
const PADRAO = { limite_reclamacoes: 0.01, limite_cancelamentos: 0.01, limite_atraso: 0.05, alerta_em: 0.75, beep: true };

const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const gravar = (arq, d) => { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(d, null, 2), 'utf8'); };
const configuracao = () => ({ ...PADRAO, ...lerJson(ARQ_CFG, {}) });

let notificar = () => {};
function usarNotificador(fn) { notificar = fn; }
const avisadoEm = {};
let rodando = false;

async function verificarConta(conta, c) {
    const h = await contas.cabecalhos(conta);
    const { data: u } = await axios.get('https://api.mercadolibre.com/users/me', { headers: h, timeout: 20000 });
    const r = u.seller_reputation || {}, m = r.metrics || {};
    const metricas = [
        { id: 'reclamacoes', nome: 'Reclamações', taxa: (m.claims || {}).rate || 0, qtd: (m.claims || {}).value || 0, limite: c.limite_reclamacoes },
        { id: 'cancelamentos', nome: 'Cancelamentos', taxa: (m.cancellations || {}).rate || 0, qtd: (m.cancellations || {}).value || 0, limite: c.limite_cancelamentos },
        { id: 'atraso', nome: 'Atraso no envio', taxa: (m.delayed_handling_time || {}).rate || 0, qtd: (m.delayed_handling_time || {}).value || 0, limite: c.limite_atraso },
    ].map(x => ({ ...x, uso: x.limite ? x.taxa / x.limite : 0 }));
    const pior = metricas.reduce((a, b) => (b.uso > a.uso ? b : a), metricas[0]);
    return {
        conta, nome: contas.CONTAS[conta].nome, verificado_em: new Date().toISOString(), nickname: u.nickname, nivel: r.level_id,
        medalha: r.power_seller_status, vendas60: (m.sales || {}).completed || 0, metricas, pior: pior.id, em_risco: pior.uso >= c.alerta_em, alerta_em: c.alerta_em,
    };
}

async function verificar() {
    if (rodando) return resumo();
    rodando = true;
    try {
        const c = configuracao(), atual = lerJson(ARQ, { contas: {} });
        for (const conta of Object.keys(contas.CONTAS)) {
            try {
                const s = await verificarConta(conta, c);
                atual.contas[conta] = s;
                if (s.em_risco && Date.now() - (avisadoEm[conta] || 0) > REAVISAR_MS) {
                    avisadoEm[conta] = Date.now();
                    const ruins = s.metricas.filter(x => x.uso >= c.alerta_em).map(x => `${x.nome}: ${(x.taxa * 100).toFixed(2)}% (${x.qtd}) de ${(x.limite * 100).toFixed(0)}% · ${Math.round(x.uso * 100)}% do limite`);
                    notificar(`RISCO DE PERDER O PLATINUM — ${s.nome}`, ruins.join('\n'), { beep: c.beep });
                    log.aviso('reputacao', 'REPUTACAO_RISCO', `${s.nome}: ${ruins.join(' | ')}`);
                }
            } catch (e) {
                atual.contas[conta] = { ...(atual.contas[conta] || { conta, nome: contas.CONTAS[conta].nome, metricas: [] }), erro: String(e.response?.data?.message || e.message).slice(0, 200), erro_em: new Date().toISOString() };
            }
        }
        atual.verificado_em = new Date().toISOString();
        gravar(ARQ, atual);
        return resumo();
    } finally { rodando = false; }
}

function resumo() {
    const d = lerJson(ARQ, { contas: {} });
    const lista = Object.keys(contas.CONTAS).map(k => d.contas[k] || { conta: k, nome: contas.CONTAS[k].nome, metricas: [], em_risco: false });
    return { verificado_em: d.verificado_em || null, em_risco: lista.some(x => x.em_risco), contas: lista, config: configuracao() };
}

let t1 = null, t2 = null;
function iniciar() { parar(); t1 = setTimeout(() => verificar().catch(() => {}), PRIMEIRA_MS); t2 = setInterval(() => verificar().catch(() => {}), INTERVALO_MS); }
function parar() { if (t1) clearTimeout(t1); if (t2) clearInterval(t2); t1 = t2 = null; }

module.exports = { verificar, resumo, iniciar, parar, usarNotificador };
