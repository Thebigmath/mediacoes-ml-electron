// "O dinheiro cai na nossa conta?" — conferencia de cada mediacao ENCERRADA (pedido da Ana, 13/10/2026).
// Le o pagamento do pedido (Mercado Livre /orders + Mercado Pago /v1/payments) e diz, em portugues:
//   recebe   -> venda mantida (pagamento aprovado, nada devolvido): o dinheiro e da loja
//   coberto  -> o ML cobriu o reembolso do comprador (status_detail "bpp_covered"): o dinheiro da venda fica com a loja
//   parcial  -> devolucao parcial: parte volta ao comprador, o resto fica com a loja
//   estorno  -> o dinheiro voltou para o comprador (ex.: "bpp_refunded"): nao cai na conta
// Mais a liberacao no Mercado Pago (money_release_status/date): "liberado em" ou "libera em".
// Conferido em 13/10/2026 nas reclamacoes 5585969088 (bpp_covered, liquido R$ 190,13 liberado) e 5586329644 (bpp_refunded).
const axios = require('axios');
const contas = require('./contas');
const banco = require('./banco');

const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dia = (s) => s ? new Date(s).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';

async function get(conta, url) {
    for (let t = 1; ; t++) {
        try { return (await axios.get(url, { headers: await contas.cabecalhos(conta), timeout: 30000 })).data; }
        catch (e) { const st = e.response?.status; if ((st === 429 || st >= 500 || !e.response) && t < 4) { await new Promise(r => setTimeout(r, 1500 * t)); continue; } throw e; }
    }
}

async function conferir(id) {
    const m = banco.obter(id);
    if (!m) throw new Error('Mediação não encontrada.');
    if (m.status_ml === 'opened') return salvar(id, { estado: 'aberta', texto: 'A mediação ainda está aberta: o Mercado Livre não decidiu.' });
    if (!m.order_id) return salvar(id, { estado: 'sem_pedido', texto: 'Não achei o pedido desta mediação para conferir o pagamento.' });

    const o = await get(m.conta, `https://api.mercadolibre.com/orders/${m.order_id}`);
    const pags = [];
    for (const p of o.payments || []) {
        let mp = null;
        try { mp = await get(m.conta, `https://api.mercadopago.com/v1/payments/${p.id}`); } catch { /* sem acesso ao MP: fica so com o pedido */ }
        pags.push({
            status: mp?.status || p.status, detalhe: mp?.status_detail || p.status_detail || '',
            total: Number(mp?.transaction_amount ?? p.transaction_amount ?? 0), devolvido: Number(mp?.transaction_amount_refunded ?? p.transaction_amount_refunded ?? 0),
            liquido: mp?.transaction_details?.net_received_amount ?? null, liberacao: mp?.money_release_status || null, liberacao_data: mp?.money_release_date || p.money_release_date || null,
        });
    }
    if (!pags.length) return salvar(id, { estado: 'sem_pedido', texto: 'O pedido não tem pagamento para conferir.' });

    const total = r2(pags.reduce((s, p) => s + p.total, 0)), devolvido = r2(pags.reduce((s, p) => s + p.devolvido, 0));
    const liquido = pags.every(p => p.liquido != null) ? r2(pags.reduce((s, p) => s + p.liquido, 0)) : null;
    const liberado = pags.every(p => p.liberacao === 'released') ? true : pags.some(p => p.liberacao) ? false : null;
    const quando = pags.map(p => p.liberacao_data).filter(Boolean).sort().pop() || null;
    const lib = liberado === true ? ` Liberado na conta do Mercado Pago em ${dia(quando)}.` : liberado === false && quando ? ` Liberação prevista na conta do Mercado Pago: ${dia(quando)}.` : '';
    const valor = liquido != null ? `${brl(liquido)} líquidos` : brl(total - devolvido);
    let r;
    if (pags.some(p => /covered/.test(p.detalhe)))
        r = { estado: 'coberto', texto: `O Mercado Livre cobriu o reembolso do comprador: o dinheiro da venda (${valor}) fica com a loja.${lib}` };
    else if (devolvido <= 0.01 && pags.every(p => p.status === 'approved'))
        r = { estado: 'recebe', texto: `Venda mantida: nada foi devolvido ao comprador e o dinheiro (${valor}) é da loja.${lib}` };
    else if (devolvido > 0.01 && devolvido < total - 0.01)
        r = { estado: 'parcial', texto: `Devolução parcial: ${brl(devolvido)} voltaram ao comprador e ${brl(total - devolvido)} ficam com a loja.${lib}` };
    else
        r = { estado: 'estorno', texto: `O dinheiro voltou para o comprador (${brl(devolvido || total)}): não cai na conta da loja.${m.resolucao === 'item_returned' ? ' O produto volta para a loja.' : ''}${m.resolucao === 'coverage_decision' ? ' O ML decidiu pela cobertura, mas a venda foi estornada.' : ''}` };
    return salvar(id, { ...r, total, devolvido, liquido, liberado, liberacao_data: quando, detalhe: pags.map(p => p.detalhe).join(', ') });
}
function salvar(id, d) {
    const dinheiro = { ...d, conferido_em: new Date().toISOString() };
    banco.atualizar(id, { dinheiro });
    return dinheiro;
}

// Encerradas sem conferencia (ou com a liberacao ainda pendente): confere ate "max" por rodada
async function conferirPendentes(max = 15) {
    const alvo = banco.listar({}).filter(m => m.status_ml && m.status_ml !== 'opened' && m.order_id &&
        (!m.dinheiro || m.dinheiro.estado === 'aberta' || (m.dinheiro.liberado === false && ['coberto', 'recebe', 'parcial'].includes(m.dinheiro.estado))));
    let feitas = 0;
    for (const m of alvo.slice(0, max)) { try { await conferir(m.mediacao_id); feitas++; } catch { /* tenta na proxima rodada */ } }
    return { feitas, faltam: Math.max(0, alvo.length - feitas) };
}

module.exports = { conferir, conferirPendentes };
