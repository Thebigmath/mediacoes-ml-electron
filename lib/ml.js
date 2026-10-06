// Integracao com a API de claims (post-purchase) do Mercado Livre.
//
// Endpoints reais (todos sob /post-purchase/v1/claims):
//   GET  /claims/search?players.role=respondent&players.user_id=<seller>
//   GET  /claims/{id}   GET /claims/{id}/messages   GET /claims/{id}/affects-reputation
//   POST /claims/{id}/actions/send-message?application_id=<client_id>   {receiver_role, message}
//   (POST em /claims/{id}/messages da 405: o ML so aceita GET ali — confirmado em 01/10/2026)
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

// Pagina de 50 em 50 ate o total informado pelo ML. "completo" diz se a lista veio inteira: so com a
// lista completa da para concluir que o que sumiu dela foi encerrado (antes, com mais de 50 abertas,
// a 51a em diante era tratada como encerrada sem estar).
const POR_PAGINA = 50, MAX_CLAIMS = 1000;
async function buscarClaims(conta, { estagio = 'dispute', status = 'opened' } = {}) {
    const seller = await contas.sellerId(conta);
    // players.role/user_id e obrigatorio: sem ele a API devolve claims da plataforma inteira
    const base = { 'players.role': 'respondent', 'players.user_id': seller, limit: POR_PAGINA };
    if (estagio) base.stage = estagio;
    if (status) base.status = status;
    const lista = [], vistos = new Set();
    let total = null;
    for (let offset = 0; offset < MAX_CLAIMS; offset += POR_PAGINA) {
        const d = await get(conta, `${CLAIMS}/search`, { ...base, offset });
        const pag = d.data || [];
        total = d.paging && d.paging.total != null ? Number(d.paging.total) : total;
        for (const c of pag) if (!vistos.has(String(c.id))) { vistos.add(String(c.id)); lista.push(c); }
        if (pag.length < POR_PAGINA || (total != null && lista.length >= total)) break;
        await sleep(300);
    }
    const completo = total == null ? lista.length < POR_PAGINA : lista.length >= total;
    return { lista, total, completo };
}
const detalhe = (conta, id) => get(conta, `${CLAIMS}/${id}`);
const mensagens = async (conta, id) => (await get(conta, `${CLAIMS}/${id}/messages`)) || [];
async function reputacao(conta, id) { try { return await get(conta, `${CLAIMS}/${id}/affects-reputation`); } catch { return {}; } }
// O que o comprador ALEGOU fica em /detail ("problem"), nao na conversa: em mediacao a conversa que o
// vendedor ve so tem o mediador e o proprio vendedor. /detail tambem diz a situacao e quem deve agir.
async function situacao(conta, id) { try { return await get(conta, `${CLAIMS}/${id}/detail`); } catch { return {}; } }
// Devolucao da reclamacao (se houver): status e para onde o produto volta (Full ou vendedor).
async function devolucao(conta, id) {
    try {
        const d = await get(conta, `https://api.mercadolibre.com/post-purchase/v2/claims/${id}/returns`);
        const s = (d.shipments || [])[0] || {};
        return { status: d.status || null, envio: s.status || null, destino: (s.destination || {}).name || null, reembolso: d.refund_at || null };
    } catch { return null; }
}
// Mensagem do mediador vem em HTML (<p>, &aacute;): vira texto limpo para a tela e para a IA
const ENT = { '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&atilde;': 'ã', '&otilde;': 'õ', '&ccedil;': 'ç',
    '&acirc;': 'â', '&ecirc;': 'ê', '&ocirc;': 'ô', '&agrave;': 'à', '&Aacute;': 'Á', '&Eacute;': 'É', '&Ccedil;': 'Ç', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
function textoLimpo(h) {
    return String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, '')
        .replace(/&[a-zA-Z#0-9]+;/g, e => ENT[e] ?? (/^&#\d+;$/.test(e) ? String.fromCharCode(Number(e.slice(2, -1))) : e))
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

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
            const r = await axios.post(`${CLAIMS}/${claimId}/actions/send-message`, { receiver_role: para, message: texto },
                { headers: h, params: { application_id: contas.applicationId(conta) }, timeout: TIMEOUT });
            return { sucesso: true, claim_id: claimId, conta, acao, receiver_role: para, pedido: String(c.resource_id || ''), resposta_ml: r.data };
        } catch (e) {
            const st = e.response?.status;
            const corpo = JSON.stringify(e.response?.data || '').slice(0, 250);
            if (st === 400) return { sucesso: false, erro: `O ML recusou o envio (400): ${corpo}`, http: 400, detalhes: corpo };
            if (st === 403) return { sucesso: false, erro: 'O ML recusou (403): a conta não tem acesso a esta reclamação.' };
            if (st === 409) return { sucesso: false, erro: 'Conflito no ML: essa resposta já foi enviada ou a reclamação mudou. Atualize a lista.' };
            return { sucesso: false, erro: `HTTP ${st || ''}: ${(e.response?.data && e.response.data.message) || e.message}`, http: st || null, detalhes: corpo };
        }
    } finally { travas.delete(claimId); }
}

function montarRegistro(conta, claim, det, msgs, rep, sit, dev) {
    det = det || claim; rep = rep || {}; sit = sit || {};
    // o ML devolve da mais nova para a mais antiga: aqui fica da mais antiga para a mais nova
    msgs = [...(msgs || [])].sort((a, b) => String(a.date_created || '').localeCompare(String(b.date_created || '')));
    const resol = det.resolution;
    const recurso = det.resource || claim.resource;
    let pergunta = '';
    for (const m of msgs) if (['complainant', 'buyer'].includes(m.sender_role)) { pergunta = textoLimpo(m.message); break; }
    if (!pergunta && sit.problem) pergunta = String(sit.problem).trim();   // alegacao registrada pelo ML
    if (!pergunta) pergunta = `Reclamação ${det.reason_id || claim.id} (${msgs.length} mensagens)`;
    const moderadas = msgs.filter(m => !['clean', undefined, null].includes((m.message_moderation || {}).status));
    return {
        mediacao_id: String(claim.id), conta,
        vendedor_id: String(jogador(det, 'respondent').user_id || ''),
        comprador_id: String(jogador(det, 'complainant').user_id || ''),
        tema: tema(det.reason_id || claim.reason_id),
        pergunta_original: pergunta,
        alegacao: sit.problem || null, situacao: sit.title || null, situacao_detalhe: sit.description || null,
        quem_age: sit.action_responsible || null, devolucao: dev || null,
        stage: det.stage || claim.stage, status_ml: det.status || claim.status,
        resource: recurso, resource_id: String(det.resource_id || claim.resource_id || ''),
        order_id: recurso === 'order' ? String(det.resource_id || '') : '',
        afeta_reputacao: rep.affects_reputation ?? null, prazo: rep.due_date || null,
        resolvida: !!resol, resolucao: resol ? resol.reason : null, beneficiou: resol ? resol.benefited : null,
        acao_disponivel: acaoDisponivel(det), destinatario: destinatario(det), prazo_resposta: prazoResposta(det),
        total_mensagens: msgs.length,
        moderadas: moderadas.map(m => ({ remetente: m.sender_role, motivo: (m.message_moderation || {}).reason,
            motivo_texto: MOTIVOS_MODERACAO[(m.message_moderation || {}).reason] || null, texto: textoLimpo(m.message).slice(0, 300) })),
        historico_ml: msgs.map(m => ({ remetente: m.sender_role, destinatario: m.receiver_role, texto: textoLimpo(m.message),
            quando: m.date_created, moderacao: (m.message_moderation || {}).status,
            anexos: (m.attachments || []).map(a => ({ arquivo: a.filename, nome: a.original_filename, tipo: a.type, tamanho: a.size })) })),
        criado_em: det.date_created || claim.date_created, atualizado_em_ml: det.last_updated || claim.last_updated,
    };
}

// Mediacoes abertas (stage=dispute, como no projeto original) com detalhe, conversa e reputacao.
async function sincronizar(conta, aviso = () => {}) {
    const { lista: claims, total, completo } = await buscarClaims(conta, { estagio: 'dispute' });
    const out = [];
    out.completo = completo; out.total = total;
    for (const [i, c] of claims.entries()) {
        aviso(`${contas.CONTAS[conta].nome}: ${i + 1} de ${claims.length}`);
        const id = String(c.id);
        let det = {}, msgs = [], rep = {};
        try { det = await detalhe(conta, id); } catch {}
        await sleep(200);
        try { msgs = await mensagens(conta, id); } catch {}
        await sleep(200);
        rep = await reputacao(conta, id);
        const sit = await situacao(conta, id);
        const dev = await devolucao(conta, id);
        out.push(montarRegistro(conta, c, det, msgs, rep, sit, dev));
    }
    return out;
}

// Relê uma mediação no ML (detalhe, conversa e reputação): usado ao abrir e depois de enviar.
async function atualizarUma(conta, id) {
    const det = await detalhe(conta, id);
    const msgs = await mensagens(conta, id);
    const rep = await reputacao(conta, id);
    const [sit, dev] = await Promise.all([situacao(conta, id), devolucao(conta, id)]);
    return montarRegistro(conta, det, det, msgs, rep, sit, dev);
}

// Fotos anexadas na conversa (comprador via mediador, ou nossas): baixa as mais recentes para a IA ver.
// So imagens ate 4 MB, no maximo `max`. Nada fica salvo em disco.
async function fotosDaMediacao(conta, reg, max = 4) {
    const lista = [];
    for (const m of [...(reg.historico_ml || [])].reverse()) for (const a of (m.anexos || [])) {
        if (/^image\/(jpe?g|png|webp)$/i.test(a.tipo || '') && (a.tamanho || 0) <= 4 * 1024 * 1024) lista.push({ ...a, de: m.remetente });
    }
    const out = [];
    for (const a of lista.slice(0, max)) {
        try {
            const r = await axios.get(`${CLAIMS}/${reg.mediacao_id}/attachments/${encodeURIComponent(a.arquivo)}/download`,
                { headers: await contas.cabecalhos(conta), responseType: 'arraybuffer', timeout: TIMEOUT });
            out.push({ tipo: a.tipo, base64: Buffer.from(r.data).toString('base64'), de: a.de, nome: a.nome });
        } catch {}
    }
    return out;
}
// Uma foto para a tela (a imagem passa pelo Harvey, que tem o token)
async function baixarAnexo(conta, id, arquivo) {
    const r = await axios.get(`${CLAIMS}/${id}/attachments/${encodeURIComponent(arquivo)}/download`,
        { headers: await contas.cabecalhos(conta), responseType: 'arraybuffer', timeout: TIMEOUT });
    return { dados: Buffer.from(r.data), tipo: r.headers['content-type'] || 'application/octet-stream' };
}

module.exports = { sincronizar, enviar, tema, atualizarUma, textoLimpo, fotosDaMediacao, baixarAnexo };
