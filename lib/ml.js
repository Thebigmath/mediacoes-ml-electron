// Integracao com a API de claims (post-purchase) do Mercado Livre.
//
// Endpoints reais (todos sob /post-purchase/v1/claims):
//   GET  /claims/search?players.role=respondent&players.user_id=<seller>
//   GET  /claims/{id}   GET /claims/{id}/messages   GET /claims/{id}/affects-reputation
//   POST /claims/{id}/messages   {receiver_role, message}
//
// Estagio da claim -> para quem vai a resposta:
//   claim / recontact -> complainant (comprador)     dispute -> mediator (mediador do ML)
//
// GARANTIA CONTRA ENVIO ERRADO: antes de responder, confere no ML que a conta e a vendedora
// da claim e que o pedido continua o mesmo que a tela mostrou. Se nao bater, aborta.
const axios = require('axios');
const contas = require('./contas');

const CLAIMS = 'https://api.mercadolibre.com/post-purchase/v1/claims';
const TIMEOUT = 30000;

const TEMAS = {
    PDD: 'Produto diferente ou com defeito', PNR: 'Produto não recebido', CS: 'Compra cancelada',
    UND: 'Pedido não entregue', ITD: 'Item não entregue', DRM: 'Danos no transporte',
    INC: 'Pedido incompleto', DFF: 'Falta de mercadoria', MEA: 'Mercadoria errada', REF: 'Reembolso',
};
const MOTIVOS_MODERACAO = {
    AUTOMATIC_MESSAGE: 'Mensagem identificada como automática',
    EVASION_CLAIM_SELLER: 'Tentativa de fuga da responsabilidade do vendedor',
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tema(reasonId) {
    if (!reasonId) return 'Reclamação';
    return `${TEMAS[reasonId.slice(0, 3).toUpperCase()] || 'Reclamação'} (${reasonId})`;
}
function jogador(claim, papel) {
    return (claim.players || []).find(p => p.role === papel) || {};
}

async function get(conta, url, params, tentativa = 1) {
    try {
        return (await axios.get(url, { headers: await contas.cabecalhos(conta), params, timeout: TIMEOUT })).data;
    } catch (e) {
        const st = e.response?.status;
        if ((st === 429 || st >= 500 || !e.response) && tentativa < 4) { await sleep(1500 * tentativa); return get(conta, url, params, tentativa + 1); }
        throw e;
    }
}

async function buscarClaims(conta, { estagio = 'dispute', status = 'opened', limite = 50 } = {}) {
    const seller = await contas.sellerId(conta);
    // players.role/user_id e obrigatorio: sem ele a API devolve claims da plataforma inteira
    const params = { 'players.role': 'respondent', 'players.user_id': seller, limit: limite };
    if (estagio) params.stage = estagio;
    if (status) params.status = status;
    const d = await get(conta, `${CLAIMS}/search`, params);
    return d.data || [];
}
const detalhe = (conta, id) => get(conta, `${CLAIMS}/${id}`);
const mensagens = async (conta, id) => (await get(conta, `${CLAIMS}/${id}/messages`)) || [];
async function reputacao(conta, id) { try { return await get(conta, `${CLAIMS}/${id}/affects-reputation`); } catch { return {}; } }

// Fonte da verdade: players[].available_actions. Sem a acao na lista, nao se responde
// (prazo vencido ou ML ja decidiu). Em dispute vence falar com o mediador.
function destinatario(claim) {
    if (claim.stage === 'dispute') return 'mediator';
    if (claim.stage === 'claim' || claim.stage === 'recontact') return 'complainant';
    return null;
}
function acaoDisponivel(claim) {
    const disp = new Set();
    for (const papel of ['respondent', 'complainant']) {
        for (const it of jogador(claim, papel).available_actions || []) {
            const a = typeof it === 'object' ? it.action : it;
            if (a === 'send_message_to_mediator' || a === 'send_message_to_complainant') disp.add(a);
        }
    }
    const para = destinatario(claim);
    if (para === 'mediator' && disp.has('send_message_to_mediator')) return 'send_message_to_mediator';
    if (para === 'complainant' && disp.has('send_message_to_complainant')) return 'send_message_to_complainant';
    return [...disp].sort()[0] || null;
}
function prazoResposta(claim) {
    for (const papel of ['respondent', 'complainant']) {
        for (const it of jogador(claim, papel).available_actions || []) if (it && it.due_date) return it.due_date;
    }
    return null;
}

async function verificarDono(conta, claimId, pedidoEsperado) {
    let d;
    try { d = await detalhe(conta, claimId); }
    catch (e) { return { ok: false, motivo: `Não consegui abrir a reclamação ${claimId} no ML: ${e.message}` }; }
    const dono = String(jogador(d, 'respondent').user_id || '');
    const meu = await contas.sellerId(conta);
    if (dono !== meu) return { ok: false, motivo: `A reclamação ${claimId} é do vendedor ${dono}, não da conta ${contas.CONTAS[conta].nome} (${meu}). Envio cancelado.` };
    if (pedidoEsperado && String(d.resource_id || '') !== String(pedidoEsperado)) {
        return { ok: false, motivo: `O pedido mudou: a tela mostra ${pedidoEsperado} e o ML responde ${d.resource_id}. Envio cancelado para não responder a conversa errada.` };
    }
    return { ok: true, claim: d };
}

const travas = new Set();   // dois cliques em Enviar nao mandam duas mensagens
async function enviar(conta, claimId, texto, pedidoEsperado) {
    texto = (texto || '').trim();
    if (!texto) return { sucesso: false, erro: 'Mensagem vazia.' };
    if (travas.has(claimId)) return { sucesso: false, erro: 'Já existe um envio em andamento para esta reclamação.' };
    travas.add(claimId);
    try {
        const v = await verificarDono(conta, claimId, pedidoEsperado);
        if (!v.ok) return { sucesso: false, erro: v.motivo };
        const c = v.claim;
        if (c.status !== 'opened') return { sucesso: false, erro: `A reclamação está "${c.status}": o ML já encerrou.` };
        const acao = acaoDisponivel(c);
        if (!acao) return { sucesso: false, erro: `O ML não liberou resposta nesta reclamação agora (estágio ${c.stage}). O prazo pode ter vencido.` };
        const para = destinatario(c);
        if (!para) return { sucesso: false, erro: `Estágio "${c.stage}" sem destinatário válido.` };
        try {
            const h = { ...(await contas.cabecalhos(conta)), 'Content-Type': 'application/json' };
            const r = await axios.post(`${CLAIMS}/${claimId}/messages`, { receiver_role: para, message: texto }, { headers: h, timeout: TIMEOUT });
            return { sucesso: true, claim_id: claimId, conta, acao, receiver_role: para, pedido: String(c.resource_id || ''), resposta_ml: r.data };
        } catch (e) {
            const st = e.response?.status;
            const corpo = JSON.stringify(e.response?.data || '').slice(0, 250);
            if (st === 400) return { sucesso: false, erro: `O ML recusou o envio (400): ${corpo}` };
            if (st === 403) return { sucesso: false, erro: 'O ML recusou (403): a conta não tem acesso a esta reclamação.' };
            if (st === 409) return { sucesso: false, erro: 'Conflito no ML: essa resposta já foi enviada ou a reclamação mudou. Atualize a lista.' };
            return { sucesso: false, erro: `HTTP ${st || ''} ${e.message}`, detalhes: corpo };
        }
    } finally { travas.delete(claimId); }
}

function montarRegistro(conta, claim, det, msgs, rep) {
    det = det || claim; msgs = msgs || []; rep = rep || {};
    const resol = det.resolution;
    const recurso = det.resource || claim.resource;
    let pergunta = '';
    for (const m of msgs) if (['complainant', 'buyer'].includes(m.sender_role)) { pergunta = (m.message || '').trim(); break; }
    if (!pergunta) pergunta = `Reclamação ${det.reason_id || claim.id} (${msgs.length} mensagens)`;
    const moderadas = msgs.filter(m => !['clean', undefined, null].includes((m.message_moderation || {}).status));
    return {
        mediacao_id: String(claim.id), conta,
        vendedor_id: String(jogador(det, 'respondent').user_id || ''),
        comprador_id: String(jogador(det, 'complainant').user_id || ''),
        tema: tema(det.reason_id || claim.reason_id),
        pergunta_original: pergunta,
        stage: det.stage || claim.stage, status_ml: det.status || claim.status,
        resource: recurso, resource_id: String(det.resource_id || claim.resource_id || ''),
        order_id: recurso === 'order' ? String(det.resource_id || '') : '',
        afeta_reputacao: rep.affects_reputation ?? null, prazo: rep.due_date || null,
        resolvida: !!resol, resolucao: resol ? resol.reason : null, beneficiou: resol ? resol.benefited : null,
        acao_disponivel: acaoDisponivel(det), destinatario: destinatario(det), prazo_resposta: prazoResposta(det),
        total_mensagens: msgs.length,
        moderadas: moderadas.map(m => ({ remetente: m.sender_role, motivo: (m.message_moderation || {}).reason,
            motivo_texto: MOTIVOS_MODERACAO[(m.message_moderation || {}).reason] || null, texto: (m.message || '').slice(0, 300) })),
        historico_ml: msgs.map(m => ({ remetente: m.sender_role, destinatario: m.receiver_role, texto: m.message || '',
            quando: m.date_created, moderacao: (m.message_moderation || {}).status })),
        criado_em: det.date_created || claim.date_created, atualizado_em_ml: det.last_updated || claim.last_updated,
    };
}

// Mediacoes abertas (stage=dispute, como no projeto original) com detalhe, conversa e reputacao.
async function sincronizar(conta, limite = 50, aviso = () => {}) {
    const claims = await buscarClaims(conta, { estagio: 'dispute', limite });
    const out = [];
    for (const [i, c] of claims.entries()) {
        aviso(`${contas.CONTAS[conta].nome}: ${i + 1} de ${claims.length}`);
        const id = String(c.id);
        let det = {}, msgs = [], rep = {};
        try { det = await detalhe(conta, id); } catch {}
        await sleep(200);
        try { msgs = await mensagens(conta, id); } catch {}
        await sleep(200);
        rep = await reputacao(conta, id);
        out.push(montarRegistro(conta, c, det, msgs, rep));
    }
    return out;
}

module.exports = { sincronizar, enviar, tema };
