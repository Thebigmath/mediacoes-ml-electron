// Perguntas de pre-venda: a IA prepara a resposta com base no PRODUTO (anuncio, atributos, descricao,
// estoque, frete) e nas respostas que voces ja deram no mesmo anuncio; e, se o modo automatico estiver
// ligado, envia sozinha as que ela tem certeza. O resto fica para revisao.
//
// Guardas do envio automatico (todas precisam passar):
//   - confianca "alta" e precisa_humano = false (a IA so tem certeza quando o dado esta no anuncio)
//   - sem telefone, e-mail, link ou outro contato (o ML proibe e modera)
//   - texto entre 5 e 2000 caracteres; pergunta ainda sem resposta no ML na hora de enviar
// Arquivos (STORAGE): perguntas.json { [id]: registro }  ·  perguntas_itens.json cache do produto (6 h)
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const contas = require('./contas');
const ia = require('./ia');
const log = require('./log');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'perguntas.json');
const ITENS = path.join(STORAGE, 'perguntas_itens.json');
const CONFIG = path.join(STORAGE, 'config.json');
const ML = 'https://api.mercadolibre.com';
const INTERVALO_MS = 2 * 60 * 1000;   // a cada 2 min (a IA so roda para pergunta nova)

const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const gravarJson = (f, v) => { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1), 'utf8'); };
const automatico = () => !!lerJson(CONFIG, {}).perguntas_auto;
function setAutomatico(v) { const c = lerJson(CONFIG, {}); c.perguntas_auto = !!v; gravarJson(CONFIG, c); }

let notificar = () => {};
const estado = { rodando: false, verificado_em: null, erros: [] };
let timer = null;

async function get(conta, url, params) { return (await axios.get(url, { headers: await contas.cabecalhos(conta), params, timeout: 30000 })).data; }

// Tudo o que a IA pode usar sobre o produto (cache de 6 h)
async function produto(conta, itemId) {
    const cache = lerJson(ITENS, {});
    const c = cache[itemId];
    if (c && Date.now() - c.t < 6 * 3600 * 1000) return c.d;
    const it = await get(conta, `${ML}/items/${itemId}`, { include_attributes: 'all' });
    let descricao = '';
    try { descricao = (await get(conta, `${ML}/items/${itemId}/description`)).plain_text || ''; } catch {}
    let anteriores = [];
    try {
        const r = await get(conta, `${ML}/questions/search`, { item: itemId, api_version: 4, limit: 30, sort_fields: 'date_created', sort_types: 'DESC' });
        anteriores = (r.questions || []).filter(q => q.answer && q.answer.text).slice(0, 12).map(q => ({ p: q.text, r: q.answer.text }));
    } catch {}
    const d = {
        id: it.id, titulo: it.title, preco: it.price, estoque: it.available_quantity, condicao: it.condition, status: it.status,
        frete_gratis: !!it.shipping?.free_shipping, full: it.shipping?.logistic_type === 'fulfillment', link: it.permalink,
        garantia: (it.sale_terms || []).filter(s => /WARRANTY/.test(s.id)).map(s => `${s.name}: ${s.value_name}`).join(' · '),
        atributos: (it.attributes || []).filter(a => a.value_name && !/EMBALAGEM|PACKAGE|GTIN|Origem do dado|Regalavel/i.test(a.name + a.id)).map(a => `${a.name}: ${a.value_name}`).slice(0, 40),
        variacoes: (it.variations || []).map(v => (v.attribute_combinations || []).map(a => `${a.name}: ${a.value_name}`).join(', ') + ` (estoque ${v.available_quantity})`).slice(0, 20),
        descricao: descricao.slice(0, 4000), anteriores,
    };
    cache[itemId] = { t: Date.now(), d };
    gravarJson(ITENS, cache);
    return d;
}

const NEGATIVA = /(n[ãa]o\s+(temos|tem|consta|serve|é\s+compat|e\s+compat|possu|acompanha|vem|trabalhamos|vendemos)|infelizmente|indispon[ií]vel|sem\s+estoque)/i;
const CONTATO = /(\b\d{2}\s?9?\d{4}[-\s]?\d{4}\b)|(@[a-z0-9-]+\.)|(https?:\/\/)|(www\.)|(whats\s?app|zap\b|instagram|telefone|e-?mail)/i;
function podeEnviarSozinho(a) {
    const t = String(a.resposta || '').trim();
    if (a.confianca !== 'alta' || a.precisa_humano) return { ok: false, motivo: a.motivo || 'a IA não tem certeza' };
    if (t.length < 5 || t.length > 2000) return { ok: false, motivo: 'tamanho da resposta fora do permitido' };
    if (CONTATO.test(t)) return { ok: false, motivo: 'a resposta cita contato/link, que o ML proíbe' };
    // resposta negativa ("nao temos", "nao consta", "infelizmente") pode perder a venda: sempre passa por voce
    if (NEGATIVA.test(t)) return { ok: false, motivo: 'resposta negativa: confira antes de enviar (a IA só conhece este anúncio)' };
    return { ok: true };
}

async function enviarResposta(conta, id, texto) {
    const h = { ...(await contas.cabecalhos(conta)), 'Content-Type': 'application/json' };
    // confere que ainda esta sem resposta (pode ter sido respondida pelo site ou pelo Dashboard)
    const q = await get(conta, `${ML}/questions/${id}`, { api_version: 4 });
    if (q.status !== 'UNANSWERED') return { ok: false, ja_respondida: true, erro: `A pergunta já está ${q.status === 'ANSWERED' ? 'respondida' : q.status} no ML.` };
    await axios.post(`${ML}/answers`, { question_id: Number(id), text: String(texto).trim() }, { headers: h, timeout: 30000 });
    return { ok: true };
}

async function analisar(reg) {
    const p = await produto(reg.conta, reg.item_id);
    const a = await ia.responderPergunta(reg.texto, p);
    return { ...a, produto_titulo: p.titulo };
}

async function verificar() {
    if (estado.rodando) return { ok: false, erro: 'já está verificando' };
    estado.rodando = true; estado.erros = [];
    const db = lerJson(ARQ, {});
    let novas = 0, enviadas = 0, revisar = 0;
    try {
        for (const conta of Object.keys(contas.CONTAS)) {
            let abertas = [];
            try { abertas = (await get(conta, `${ML}/my/received_questions/search`, { api_version: 4, status: 'UNANSWERED', limit: 50, sort_fields: 'date_created', sort_types: 'ASC' })).questions || []; }
            catch (e) { estado.erros.push(`${contas.CONTAS[conta].nome}: ${e.response?.status || ''} ${e.message}`); log.erro('perguntas', 'PERG_ERRO', `${contas.CONTAS[conta].nome}: ${e.message}`, { http: e.response?.status || null }); continue; }
            const ids = new Set(abertas.map(q => String(q.id)));
            // o que estava aberto aqui e saiu da lista foi respondido por fora (site, celular, Dashboard)
            for (const r of Object.values(db)) if (r.conta === conta && ['revisar', 'analisando'].includes(r.status) && !ids.has(r.id)) r.status = 'respondida_fora';
            for (const q of abertas) {
                const id = String(q.id);
                if (!db[id]) {
                    db[id] = { id, conta, item_id: q.item_id, texto: q.text || '', criado: q.date_created, status: 'analisando' };
                    novas++;
                    log.info('perguntas', 'PERG_NOVA', `${contas.CONTAS[conta].nome}: "${String(q.text || '').slice(0, 80)}"`, { pergunta: id, item: q.item_id });
                }
                const r = db[id];
                if (r.status !== 'analisando') continue;
                try {
                    r.ia = await analisar(r); r.produto_titulo = r.ia.produto_titulo; r.analisado_em = new Date().toISOString();
                    const ok = podeEnviarSozinho(r.ia);
                    log.info('perguntas', 'PERG_IA', `${r.produto_titulo}: confiança ${r.ia.confianca}`, { pergunta: id, modelo: r.ia.modelo });
                    if (automatico() && ok.ok) {
                        const env = await enviarResposta(conta, id, r.ia.resposta);
                        if (env.ok) { Object.assign(r, { status: 'enviada', resposta_enviada: r.ia.resposta, enviada_em: new Date().toISOString(), automatica: true }); enviadas++;
                            log.info('perguntas', 'PERG_AUTO_ENVIADA', `${contas.CONTAS[conta].nome}: "${r.texto.slice(0, 60)}" → "${r.ia.resposta.slice(0, 80)}"`, { pergunta: id }); }
                        else { r.status = env.ja_respondida ? 'respondida_fora' : 'revisar'; r.motivo = env.erro; }
                    } else {
                        r.status = 'revisar'; r.motivo = automatico() ? ok.motivo : 'modo automático desligado'; revisar++;
                        log.info('perguntas', 'PERG_REVISAR', `${r.produto_titulo}: ${r.motivo}`, { pergunta: id });
                    }
                } catch (e) {
                    r.status = 'revisar'; r.motivo = `a IA não conseguiu analisar (${e.message})`; revisar++;
                    log.erro('perguntas', 'PERG_ERRO', `Pergunta ${id}: ${e.message}`, { pergunta: id });
                }
                gravarJson(ARQ, db);
            }
        }
    } finally {
        gravarJson(ARQ, db);
        estado.rodando = false; estado.verificado_em = new Date().toISOString();
    }
    if (enviadas) notificar(enviadas === 1 ? 'Harvey respondeu 1 pergunta' : `Harvey respondeu ${enviadas} perguntas`, 'Respondidas automaticamente com os dados do anúncio.');
    if (revisar) notificar(revisar === 1 ? '1 pergunta para revisar' : `${revisar} perguntas para revisar`, 'A IA preparou a resposta, mas precisa da sua confirmação.');
    return { ok: true, novas, enviadas, revisar };
}

// Envio pela tela (revisado pela pessoa)
async function responder(id, texto) {
    const db = lerJson(ARQ, {}); const r = db[id];
    if (!r) throw new Error('Pergunta não encontrada.');
    const t = String(texto || '').trim();
    if (t.length < 2) throw new Error('Resposta vazia.');
    if (t.length > 2000) throw new Error('A resposta passa de 2000 caracteres.');
    const env = await enviarResposta(r.conta, id, t);
    if (!env.ok) { if (env.ja_respondida) { r.status = 'respondida_fora'; gravarJson(ARQ, db); } throw new Error(env.erro); }
    Object.assign(r, { status: 'enviada', resposta_enviada: t, enviada_em: new Date().toISOString(), automatica: false });
    gravarJson(ARQ, db);
    log.info('perguntas', 'PERG_ENVIADA', `${contas.CONTAS[r.conta].nome}: resposta enviada (revisada)`, { pergunta: id });
    return r;
}
async function gerarDeNovo(id) {
    const db = lerJson(ARQ, {}); const r = db[id];
    if (!r) throw new Error('Pergunta não encontrada.');
    const cache = lerJson(ITENS, {}); delete cache[r.item_id]; gravarJson(ITENS, cache);   // rele o anuncio
    r.ia = await analisar(r); r.analisado_em = new Date().toISOString(); r.motivo = podeEnviarSozinho(r.ia).motivo || '';
    gravarJson(ARQ, db);
    return r;
}
function ignorar(id) { const db = lerJson(ARQ, {}); if (db[id]) { db[id].status = 'ignorada'; gravarJson(ARQ, db); } }

function listar() {
    const L = Object.values(lerJson(ARQ, {})).sort((a, b) => String(b.criado).localeCompare(String(a.criado)));
    return { automatico: automatico(), estado, abertas: L.filter(r => ['revisar', 'analisando'].includes(r.status)),
        respondidas: L.filter(r => r.status === 'enviada').slice(0, 40), outras: L.filter(r => ['respondida_fora', 'ignorada'].includes(r.status)).slice(0, 20) };
}

function usarNotificador(fn) { notificar = fn; }
function iniciar() { parar(); setTimeout(() => verificar().catch(() => {}), 40 * 1000); timer = setInterval(() => verificar().catch(() => {}), INTERVALO_MS); }
function parar() { if (timer) clearInterval(timer); timer = null; }

module.exports = { verificar, responder, gerarDeNovo, ignorar, listar, setAutomatico, automatico, usarNotificador, iniciar, parar, estado };
