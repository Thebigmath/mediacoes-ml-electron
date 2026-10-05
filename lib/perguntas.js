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

// Sem \b de proposito: o \b do JavaScript nao entende acento ("não") e a versao antiga tinha um
// caractere invisivel no lugar dele, que fazia esta trava nunca disparar (corrigido na 1.0.12).
const NEGATIVA = /(n[ãa]o\s+(temos|tem|consta|serve|[ée]\s+compat|possu|acompanha|vem|trabalhamos|vendemos|encontr|dispon)|infelizmente|indispon[ií]vel|sem\s+estoque|esgotad)/i;
const CONTATO = /(\b\d{2}\s?9?\d{4}[-\s]?\d{4}\b)|(@[a-z0-9-]+\.)|(https?:\/\/)|(www\.)|(whats\s?app|zap\b|instagram|telefone|e-?mail)/i;
function podeEnviarSozinho(a) {
    const t = String(a.resposta || '').trim();
    // a IA local (Ollama) e so reserva: inventa mais. Resposta dela nunca sai sozinha.
    if (String(a.modelo || '').startsWith('ollama')) return { ok: false, motivo: 'rascunho da IA local (Ollama): revise com atenção antes de enviar' };
    if (a.confianca !== 'alta' || a.precisa_humano) return { ok: false, motivo: a.motivo || 'a IA não tem certeza' };
    if (t.length < 5 || t.length > 2000) return { ok: false, motivo: 'tamanho da resposta fora do permitido' };
    // link: so o dos NOSSOS anuncios encontrados no catalogo e permitido; mesmo assim passa por voce
    const semNossos = (a.links_nossos || []).reduce((s, l) => s.split(l).join(''), t);
    if (CONTATO.test(semNossos)) return { ok: false, motivo: 'a resposta cita contato ou link de fora, que o ML proíbe' };
    if (semNossos !== t) return { ok: false, motivo: 'indica outro anúncio nosso (com link): confira se é o certo antes de enviar' };
    // resposta negativa ("nao temos", "nao consta", "infelizmente") pode perder a venda: sempre passa por voce
    if (NEGATIVA.test(t)) return { ok: false, motivo: 'resposta negativa (não temos, sem estoque, não serve): confira antes de enviar' };
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

// Busca no NOSSO catalogo (anuncios ativos da conta) o que o comprador pediu: outro lado, outro carro,
// outra versao. So leitura. Devolve titulo, estoque e link para a IA indicar o anuncio certo.
async function catalogo(conta, busca, itemAtual) {
    const seller = await contas.sellerId(conta);
    const r = await get(conta, `${ML}/users/${seller}/items/search`, { q: busca, status: 'active', limit: 8 });
    const ids = (r.results || []).filter(id => id !== itemAtual).slice(0, 6);
    if (!ids.length) return [];
    const m = await get(conta, `${ML}/items`, { ids: ids.join(','), attributes: 'id,title,available_quantity,permalink,price' });
    return (m || []).map(x => x.body).filter(Boolean)
        .map(x => ({ titulo: x.title, estoque: x.available_quantity, preco: x.price, link: x.permalink }));
}
// Respostas que a pessoa revisou e enviou (as mais recentes): ensinam o tom curto e direto da casa.
function estiloRevisado(max = 6) {
    return Object.values(lerJson(ARQ, {}))
        .filter(r => r.status === 'enviada' && !r.automatica && r.resposta_enviada)
        .sort((a, b) => String(b.enviada_em).localeCompare(String(a.enviada_em)))
        .slice(0, max).map(r => ({ p: String(r.texto).slice(0, 200), r: String(r.resposta_enviada).slice(0, 300) }));
}

async function analisar(reg) {
    const p = await produto(reg.conta, reg.item_id);
    // 1) o que ele quer; 2) se e outra coisa, procura no nosso catalogo; 3) responde
    let cat = null;
    try {
        const e = await ia.entenderPergunta(reg.texto, p.titulo);
        if (e.pede_outro && e.busca) cat = { ...e, itens: await catalogo(reg.conta, e.busca, reg.item_id) };
        if (cat) log.info('perguntas', 'PERG_CATALOGO', `"${e.busca}": ${cat.itens.length} anúncio(s) nosso(s)`, { pergunta: reg.id });
    } catch (e) { log.aviso('perguntas', 'PERG_CATALOGO_ERRO', `Busca no catálogo falhou: ${e.message}`, { pergunta: reg.id }); }
    const a = await ia.responderPergunta(reg.texto, p, { catalogo: cat, estilo: estiloRevisado() });
    return { ...a, produto_titulo: p.titulo, catalogo: cat, links_nossos: cat ? cat.itens.map(i => i.link) : [] };
}

// Le o arquivo NA HORA, muda so a pergunta indicada e grava (sincrono: nada se intercala no meio).
// Antes a verificacao guardava uma copia do arquivo, esperava a IA por minutos e regravava a copia
// inteira, desfazendo o que a pessoa fez na tela nesse meio-tempo (ignorar, responder, gerar de novo).
function mudar(id, fn) {
    const db = lerJson(ARQ, {});
    const r = fn(db[id], db);
    gravarJson(ARQ, db);
    return r;
}
const aindaAnalisando = (id) => (lerJson(ARQ, {})[id] || {}).status === 'analisando';

async function verificar() {
    if (estado.rodando) return { ok: false, erro: 'já está verificando' };
    estado.rodando = true; estado.erros = [];
    let novas = 0, enviadas = 0, revisar = 0;
    try {
        for (const conta of Object.keys(contas.CONTAS)) {
            let abertas = [];
            try { abertas = (await get(conta, `${ML}/my/received_questions/search`, { api_version: 4, status: 'UNANSWERED', limit: 50, sort_fields: 'date_created', sort_types: 'ASC' })).questions || []; }
            catch (e) { estado.erros.push(`${contas.CONTAS[conta].nome}: ${e.response?.status || ''} ${e.message}`); log.erro('perguntas', 'PERG_ERRO', `${contas.CONTAS[conta].nome}: ${e.message}`, { http: e.response?.status || null }); continue; }
            const ids = new Set(abertas.map(q => String(q.id)));
            mudar(null, (_, db) => {
                // o que estava aberto aqui e saiu da lista foi respondido por fora (site, celular, Dashboard)
                for (const r of Object.values(db)) if (r.conta === conta && ['revisar', 'analisando'].includes(r.status) && !ids.has(r.id)) r.status = 'respondida_fora';
                for (const q of abertas) {
                    const id = String(q.id);
                    if (db[id]) continue;
                    db[id] = { id, conta, item_id: q.item_id, texto: q.text || '', criado: q.date_created, status: 'analisando' };
                    novas++;
                    log.info('perguntas', 'PERG_NOVA', `${contas.CONTAS[conta].nome}: "${String(q.text || '').slice(0, 80)}"`, { pergunta: id, item: q.item_id });
                }
            });
            for (const q of abertas) {
                const id = String(q.id);
                const r = lerJson(ARQ, {})[id];
                if (!r || r.status !== 'analisando') continue;
                let ia;
                try { ia = await analisar(r); }
                catch (e) {
                    log.erro('perguntas', 'PERG_ERRO', `Pergunta ${id}: ${e.message}`, { pergunta: id });
                    mudar(id, (cur) => { if (cur && cur.status === 'analisando') { cur.status = 'revisar'; cur.motivo = `a IA não conseguiu analisar (${e.message})`; revisar++; } });
                    continue;
                }
                const analise = { ia, produto_titulo: ia.produto_titulo, analisado_em: new Date().toISOString() };
                const ok = podeEnviarSozinho(ia);
                log.info('perguntas', 'PERG_IA', `${ia.produto_titulo}: confiança ${ia.confianca}`, { pergunta: id, modelo: ia.modelo });
                // a pessoa pode ter ignorado ou respondido pela tela enquanto a IA pensava: a acao dela vale
                if (!aindaAnalisando(id)) { log.info('perguntas', 'PERG_TELA', `Pergunta ${id}: tratada na tela durante a análise; a análise não sobrescreveu`, { pergunta: id }); continue; }
                if (automatico() && ok.ok) {
                    const env = await enviarResposta(conta, id, ia.resposta).catch(e => ({ ok: false, erro: e.message }));
                    mudar(id, (cur) => {
                        if (!cur) return;
                        Object.assign(cur, analise);
                        if (env.ok) { Object.assign(cur, { status: 'enviada', resposta_enviada: ia.resposta, enviada_em: new Date().toISOString(), automatica: true }); enviadas++; }
                        else if (cur.status === 'analisando') { cur.status = env.ja_respondida ? 'respondida_fora' : 'revisar'; cur.motivo = env.erro; }
                    });
                    if (env.ok) log.info('perguntas', 'PERG_AUTO_ENVIADA', `${contas.CONTAS[conta].nome}: "${r.texto.slice(0, 60)}" → "${ia.resposta.slice(0, 80)}"`, { pergunta: id });
                } else {
                    const motivo = automatico() ? ok.motivo : 'modo automático desligado';
                    mudar(id, (cur) => { if (cur && cur.status === 'analisando') { Object.assign(cur, analise, { status: 'revisar', motivo }); revisar++; } });
                    log.info('perguntas', 'PERG_REVISAR', `${ia.produto_titulo}: ${motivo}`, { pergunta: id });
                }
            }
        }
    } finally {
        estado.rodando = false; estado.verificado_em = new Date().toISOString();
    }
    if (enviadas) notificar(enviadas === 1 ? 'Harvey respondeu 1 pergunta' : `Harvey respondeu ${enviadas} perguntas`, 'Respondidas automaticamente com os dados do anúncio.');
    if (revisar) notificar(revisar === 1 ? '1 pergunta para revisar' : `${revisar} perguntas para revisar`, 'A IA preparou a resposta, mas precisa da sua confirmação.');
    return { ok: true, novas, enviadas, revisar };
}

// Envio pela tela (revisado pela pessoa)
async function responder(id, texto) {
    const r = lerJson(ARQ, {})[id];
    if (!r) throw new Error('Pergunta não encontrada.');
    const t = String(texto || '').trim();
    if (t.length < 2) throw new Error('Resposta vazia.');
    if (t.length > 2000) throw new Error('A resposta passa de 2000 caracteres.');
    const env = await enviarResposta(r.conta, id, t);
    if (!env.ok) { if (env.ja_respondida) mudar(id, (cur) => { if (cur) cur.status = 'respondida_fora'; }); throw new Error(env.erro); }
    const salvo = mudar(id, (cur) => { if (cur) Object.assign(cur, { status: 'enviada', resposta_enviada: t, enviada_em: new Date().toISOString(), automatica: false }); return cur; });
    log.info('perguntas', 'PERG_ENVIADA', `${contas.CONTAS[r.conta].nome}: resposta enviada (revisada)`, { pergunta: id });
    return salvo;
}
async function gerarDeNovo(id) {
    const r = lerJson(ARQ, {})[id];
    if (!r) throw new Error('Pergunta não encontrada.');
    const cache = lerJson(ITENS, {}); delete cache[r.item_id]; gravarJson(ITENS, cache);   // rele o anuncio
    const ia = await analisar(r);
    return mudar(id, (cur) => { if (cur) Object.assign(cur, { ia, analisado_em: new Date().toISOString(), motivo: podeEnviarSozinho(ia).motivo || '' }); return cur; });
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

module.exports = { analisar, podeEnviarSozinho, verificar, responder, gerarDeNovo, ignorar, listar, setAutomatico, automatico, usarNotificador, iniciar, parar, estado };
