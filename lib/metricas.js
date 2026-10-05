// Metricas das reclamacoes encerradas (ultimos N dias), das duas contas, direto da API do ML.
//
// Definicoes (para os numeros nao enganarem):
//   reembolsado      = valor devolvido ao comprador nos pedidos em que ele ganhou (payments.transaction_amount_refunded)
//   coberto pelo ML  = reembolsos em que o ML aplicou a cobertura (resolution.applied_coverage = true): nao sai do nosso bolso
//   prejuizo direto  = reembolsos em que o comprador ganhou e o ML NAO cobriu: sai do nosso bolso
// Reclamacao encerrada nao muda mais: o que ja foi lido fica em cache (metricas_cache.json) e so o novo e buscado.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const contas = require('./contas');
const log = require('./log');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE = path.join(STORAGE, 'metricas_cache.json');
const B = 'https://api.mercadolibre.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TIPO = { mediations: 'Mediação', returns: 'Devolução', cancel_purchase: 'Cancelamento pelo comprador', cancel_sale: 'Cancelamento pela venda', ml_case: 'Caso do ML' };
const RESOLUCAO = {
    warehouse_decision: 'Decidido no centro de distribuição (Full)', coverage_decision: 'Decisão de cobertura do ML', no_bpp: 'Vendedor ganhou (sem proteção ao comprador)', change_cancelled_meli: 'Troca cancelada pelo ML',
    item_returned: 'Produto devolvido', return_expired: 'Devolução expirou', product_delivered: 'Produto entregue', prefered_to_keep_product: 'Comprador ficou com o produto',
    return_cancelled: 'Devolução cancelada', item_changed: 'Produto trocado', payment_refunded: 'Pagamento reembolsado', change_expired: 'Troca expirou',
    worked_out_with_seller: 'Resolvido com o vendedor', timeout: 'Prazo encerrado', warehouse_timeout: 'Prazo do centro de distribuição',
};

function ler() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return { claims: {}, motivos: {}, pedidos: {} }; } }
function gravar(c) { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c), 'utf8'); }

async function get(conta, url, params, t = 1) {
    try { return (await axios.get(url, { headers: await contas.cabecalhos(conta), params, timeout: 30000 })).data; }
    catch (e) { const st = e.response?.status; if ((st === 429 || st >= 500 || !e.response) && t < 4) { await sleep(1500 * t); return get(conta, url, params, t + 1); } throw e; }
}
async function limitado(lista, n, fn) { let k = 0; await Promise.all(Array.from({ length: n }, async () => { while (k < lista.length) { const x = lista[k++]; await fn(x); } })); }

let coletando = null;
// Busca (ou completa) as reclamacoes encerradas dos ultimos `dias` e os pedidos em que o comprador ganhou.
async function coletar(dias = 90) {
    if (coletando) return coletando;
    coletando = (async () => {
        const c = ler(); const limite = Date.now() - dias * 86400000; const t0 = Date.now(); let novas = 0;
        for (const conta of Object.keys(contas.CONTAS)) {
            const seller = await contas.sellerId(conta);
            for (let off = 0; off < 5000; off += 50) {
                const s = await get(conta, `${B}/post-purchase/v1/claims/search`, { 'players.role': 'respondent', 'players.user_id': seller, status: 'closed', limit: 50, offset: off, sort: 'date_created:desc' });
                const lote = s.data || [];
                if (!lote.length) break;
                let jaConhecidas = 0;
                for (const x of lote) {
                    if (c.claims[x.id]) { jaConhecidas++; continue; }
                    c.claims[x.id] = { id: x.id, conta, type: x.type, reason_id: x.reason_id, resource: x.resource, resource_id: x.resource_id,
                        resolucao: x.resolution?.reason || null, beneficiado: x.resolution?.benefited || [], cobertura: x.resolution?.applied_coverage ?? null,
                        fechada_por: x.resolution?.closed_by || null, criado: x.date_created, fechado: x.resolution?.date_created || x.last_updated };
                    novas++;
                }
                if (new Date(lote[lote.length - 1].date_created).getTime() < limite) break;
                if (jaConhecidas === lote.length && off > 0) break;   // daqui para tras ja esta no cache
            }
        }
        // nomes dos motivos (endpoint de reasons do ML)
        const motivos = [...new Set(Object.values(c.claims).map(x => x.reason_id).filter(Boolean))].filter(m => !c.motivos[m]);
        await limitado(motivos, 4, async (m) => {
            try { const r = await get('flavia', `${B}/post-purchase/v1/claims/reasons/${m}`); c.motivos[m] = { nome: r.detail || r.name || m, fluxo: r.flow || '' }; }
            catch { c.motivos[m] = { nome: m, fluxo: '' }; }
        });
        // pedidos das reclamacoes em que o comprador ganhou (valor reembolsado e produto)
        const alvo = Object.values(c.claims).filter(x => new Date(x.criado).getTime() >= limite && x.beneficiado.includes('complainant') && !c.pedidos[x.id]);
        await limitado(alvo, 5, async (x) => {
            try {
                let orderId = x.resource === 'order' ? x.resource_id : null;
                if (x.resource === 'shipment') orderId = (await get(x.conta, `${B}/shipments/${x.resource_id}`)).order_id;
                if (!orderId) { c.pedidos[x.id] = { erro: 'sem pedido' }; return; }
                const o = await get(x.conta, `${B}/orders/${orderId}`);
                const it = (o.order_items || [])[0] || {};
                c.pedidos[x.id] = { pedido: String(orderId), total: o.total_amount || 0,
                    reembolsado: (o.payments || []).reduce((s, p) => s + (Number(p.transaction_amount_refunded) || 0), 0),
                    item_id: it.item?.id || null, titulo: it.item?.title || '', sku: it.item?.seller_sku || it.item?.seller_custom_field || '' };
            } catch (e) { c.pedidos[x.id] = { erro: `${e.response?.status || ''} ${e.message}` }; }
        });
        c.atualizado_em = new Date().toISOString();
        gravar(c);
        log.info('metricas', 'METRICAS_OK', `Métricas atualizadas: ${novas} reclamação(ões) nova(s), ${alvo.length} pedido(s) lidos em ${Math.round((Date.now() - t0) / 1000)} s`);
        return c;
    })().catch(e => { log.erro('metricas', 'METRICAS_ERRO', e.message, { http: e.response?.status || null }); throw e; })
        .finally(() => { coletando = null; });
    return coletando;
}

const r2 = (v) => Math.round(v * 100) / 100;
// Agrega o cache para a tela (e para a IA).
function resumo({ dias = 90, conta } = {}) {
    const c = ler(); const limite = Date.now() - dias * 86400000;
    const L = Object.values(c.claims).filter(x => new Date(x.criado).getTime() >= limite && (!conta || x.conta === conta));
    const ped = (x) => c.pedidos[x.id] || {};
    const compradorGanhou = L.filter(x => x.beneficiado.includes('complainant') && !x.beneficiado.includes('respondent'));
    const vendedorGanhou = L.filter(x => x.beneficiado.includes('respondent') && !x.beneficiado.includes('complainant'));
    const dividido = L.filter(x => x.beneficiado.includes('respondent') && x.beneficiado.includes('complainant'));
    const reemb = (arr) => r2(arr.reduce((s, x) => s + (ped(x).reembolsado || 0), 0));
    const comprador = L.filter(x => x.beneficiado.includes('complainant'));
    const coberto = comprador.filter(x => x.cobertura === true);
    const semCobertura = comprador.filter(x => x.cobertura !== true);
    const agrupar = (f, extra) => {
        const o = {};
        for (const x of L) { const k = f(x); if (!k) continue; (o[k] = o[k] || []).push(x); }
        return Object.entries(o).map(([k, arr]) => ({ chave: k, qtd: arr.length, comprador_ganhou: arr.filter(x => x.beneficiado.includes('complainant')).length,
            reembolsado: reemb(arr.filter(x => x.beneficiado.includes('complainant'))), prejuizo: reemb(arr.filter(x => x.beneficiado.includes('complainant') && x.cobertura !== true)), ...(extra ? extra(k, arr) : {}) }))
            .sort((a, b) => b.qtd - a.qtd);
    };
    const motivos = agrupar(x => x.reason_id, (k) => ({ nome: (c.motivos[k] || {}).nome || k, tipo: k.slice(0, 3) === 'PDD' ? 'Produto diferente ou com defeito' : k.slice(0, 3) === 'PNR' ? 'Produto não recebido' : 'Outro' }));
    const produtos = agrupar(x => ped(x).item_id, (k, arr) => ({ titulo: ped(arr[0]).titulo, sku: ped(arr[0]).sku })).filter(p => p.chave && p.chave !== 'undefined').slice(0, 15);
    const meses = {};
    for (const x of L) { const m = String(x.criado).slice(0, 7); meses[m] = meses[m] || { qtd: 0, prejuizo: 0 }; meses[m].qtd++; if (x.beneficiado.includes('complainant') && x.cobertura !== true) meses[m].prejuizo = r2(meses[m].prejuizo + (ped(x).reembolsado || 0)); }
    return {
        dias, conta: conta || null, atualizado_em: c.atualizado_em || null,
        total: L.length,
        comprador_ganhou: compradorGanhou.length, vendedor_ganhou: vendedorGanhou.length, dividido: dividido.length, sem_decisao: L.length - compradorGanhou.length - vendedorGanhou.length - dividido.length,
        reembolsado_total: reemb(comprador), coberto_ml: reemb(coberto), prejuizo_direto: reemb(semCobertura),
        qtd_coberto: coberto.length, qtd_sem_cobertura: semCobertura.length,
        pedidos_sem_valor: comprador.filter(x => ped(x).reembolsado == null).length,
        por_conta: Object.keys(contas.CONTAS).map(k => ({ conta: k, nome: contas.CONTAS[k].nome, qtd: L.filter(x => x.conta === k).length,
            prejuizo: reemb(semCobertura.filter(x => x.conta === k)), reembolsado: reemb(comprador.filter(x => x.conta === k)) })),
        por_tipo: agrupar(x => x.type).map(t => ({ ...t, nome: TIPO[t.chave] || t.chave })),
        por_resolucao: agrupar(x => x.resolucao).map(t => ({ ...t, nome: RESOLUCAO[t.chave] || t.chave })),
        motivos: motivos.slice(0, 12), produtos,
        perdas: semCobertura.map(x => ({ id: x.id, conta: x.conta, motivo: (c.motivos[x.reason_id] || {}).nome || x.reason_id, tipo: TIPO[x.type] || x.type,
            resolucao: RESOLUCAO[x.resolucao] || x.resolucao, valor: ped(x).reembolsado || 0, produto: ped(x).titulo, pedido: ped(x).pedido, data: x.criado }))
            .sort((a, b) => b.valor - a.valor).slice(0, 30),
        meses: Object.entries(meses).sort().map(([mes, v]) => ({ mes, ...v })),
    };
}

// Atualizacao automatica: uma vez por dia. Confere 90 s depois de abrir e depois a cada hora; so coleta
// se a ultima coleta tiver mais de 24 h. So le o que e novo (o resto ja esta no cache), entao e rapido.
const DIA_MS = 24 * 3600 * 1000;
let timerAuto = null;
async function talvezAtualizar() {
    const ult = ler().atualizado_em;
    if (ult && Date.now() - new Date(ult).getTime() < DIA_MS) return;
    log.info('metricas', 'METRICAS_AUTO', `Atualização diária das métricas (última: ${ult ? new Date(ult).toLocaleString('pt-BR') : 'nunca'})`);
    try { await coletar(90); } catch {}   // o erro ja fica no log (METRICAS_ERRO); tenta de novo na proxima hora
}
function iniciarAutomatico() {
    pararAutomatico();
    timerAuto = setTimeout(function rodar() { talvezAtualizar().finally(() => { timerAuto = setTimeout(rodar, 3600 * 1000); }); }, 90 * 1000);
}
function pararAutomatico() { if (timerAuto) clearTimeout(timerAuto); timerAuto = null; }

module.exports = { coletar, resumo, iniciarAutomatico, pararAutomatico, talvezAtualizar };
