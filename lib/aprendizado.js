// Aprendizado com as perguntas JA RESPONDIDAS pela equipe no Mercado Livre (as duas contas).
// Uma vez por dia o Harvey baixa as perguntas respondidas (GET /questions/search?status=ANSWERED),
// guarda em STORAGE/aprendizado_perguntas.json e, para cada pergunta nova, separa as respostas reais
// mais parecidas (de qualquer anuncio) para a IA seguir o jeito da equipe: o que se responde, o tom e
// o tamanho. Nao e treino de modelo: sao exemplos escolhidos na hora (rapido, barato e auditavel).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const contas = require('./contas');
const log = require('./log');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'aprendizado_perguntas.json');
const ML = 'https://api.mercadolibre.com';
const VALIDADE_MS = 24 * 3600 * 1000;
const MAX_POR_CONTA = 1000;   // a API do ML nao pagina alem disso
let sincronizando = null;

const lerBase = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return { em: null, itens: [] }; } };

async function sincronizar() {
    if (sincronizando) return sincronizando;
    sincronizando = (async () => {
        const itens = [];
        for (const conta of ['flavia', 'cordeiro']) {
            let h, me;
            try { h = await contas.cabecalhos(conta); me = (await axios.get(`${ML}/users/me`, { headers: h, timeout: 20000 })).data; }
            catch (e) { log.aviso('perguntas', 'APRENDIZADO_SEM_CONTA', `${conta}: ${e.message}`); continue; }
            const daConta = [];
            for (let off = 0; off < MAX_POR_CONTA; off += 50) {
                let r;
                try { r = (await axios.get(`${ML}/questions/search`, { headers: h, timeout: 30000,
                    params: { seller_id: me.id, status: 'ANSWERED', api_version: 4, limit: 50, offset: off, sort_fields: 'date_created', sort_types: 'DESC' } })).data; }
                catch { break; }
                for (const q of r.questions || []) if (q.answer && q.answer.text)
                    daConta.push({ conta, item_id: q.item_id, p: String(q.text || '').slice(0, 400), r: String(q.answer.text).slice(0, 600), data: q.date_created });
                if (!(r.questions || []).length || off + 50 >= (r.total || 0)) break;
            }
            // titulo de cada anuncio (20 por chamada), para achar exemplos do mesmo tipo de produto
            const ids = [...new Set(daConta.map(x => x.item_id))];
            const titulos = {};
            for (let i = 0; i < ids.length; i += 20) {
                try {
                    const d = (await axios.get(`${ML}/items`, { headers: h, timeout: 30000, params: { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title' } })).data;
                    for (const x of d) if (x.code === 200) titulos[x.body.id] = x.body.title;
                } catch {}
            }
            for (const x of daConta) x.titulo = titulos[x.item_id] || '';
            itens.push(...daConta);
        }
        if (!itens.length) return lerBase();
        const base = { em: new Date().toISOString(), itens };
        fs.mkdirSync(STORAGE, { recursive: true });
        fs.writeFileSync(ARQ, JSON.stringify(base), 'utf8');
        log.info('perguntas', 'APRENDIZADO_ATUALIZADO', `${itens.length} perguntas respondidas pela equipe guardadas para a IA aprender`);
        return base;
    })();
    try { return await sincronizando; } finally { sincronizando = null; }
}

// Base atual; se estiver velha, atualiza em segundo plano (a pergunta nao espera)
function base() {
    const b = lerBase();
    if (!b.em || Date.now() - new Date(b.em).getTime() > VALIDADE_MS) sincronizar().catch(() => {});
    return b;
}

const PARADAS = new Set('para com sem que uma uns umas por pelo pela pelos pelas mais esse essa este esta isso isto voce voces ele ela tem ter qual quais como quando onde serve servir fica ficar sao nao sim obrigado obrigada bom boa dia tarde noite ola oi produto peca pecas anuncio vcs vc pra pro'.split(' '));
const palavras = (t) => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !PARADAS.has(w)));

// Respostas reais mais parecidas: palavras em comum com a pergunta valem mais que com o titulo;
// mesmo anuncio ganha bonus; entre empates, a mais recente.
function exemplos(pergunta, titulo, itemId, max = 6) {
    const b = base();
    if (!b.itens.length) return [];
    const wp = palavras(pergunta), wt = palavras(titulo);
    const notas = [];
    for (const x of b.itens) {
        let n = 0;
        const xp = palavras(x.p), xt = palavras(x.titulo);
        for (const w of wp) if (xp.has(w)) n += 3;
        for (const w of wt) if (xt.has(w)) n += 1;
        if (x.item_id === itemId) n += 2;
        if (n >= 4) notas.push([n, x]);
    }
    notas.sort((a, b2) => b2[0] - a[0] || String(b2[1].data).localeCompare(String(a[1].data)));
    const vistos = new Set(), out = [];
    for (const [, x] of notas) {
        const chave = x.r.slice(0, 60);
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        out.push({ produto: x.titulo.slice(0, 70), pergunta: x.p, resposta: x.r });
        if (out.length >= max) break;
    }
    return out;
}

function estado() { const b = lerBase(); return { atualizado_em: b.em, total: b.itens.length, flavia: b.itens.filter(x => x.conta === 'flavia').length, cordeiro: b.itens.filter(x => x.conta === 'cordeiro').length }; }

module.exports = { sincronizar, exemplos, estado };
