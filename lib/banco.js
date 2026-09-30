// Banco local das mediacoes: arquivos JSON no storage do app (sem SQLite, sem modulo nativo).
//   mediacoes.json   { [mediacao_id]: registro + analise + status local }
//   historico.jsonl  uma acao por linha (analise, reanalise, edicao, envio)
// Ordem da lista: prioridade alta > media > baixa, depois score e data (mesma regra do projeto
// original, que corrigiu o ORDER BY alfabetico).
const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'mediacoes.json');
const HIST = path.join(STORAGE, 'historico.jsonl');
const ORDEM = { alta: 0, media: 1, baixa: 2 };
const CAMPOS_ML = ['conta', 'vendedor_id', 'comprador_id', 'tema', 'pergunta_original', 'stage', 'status_ml', 'resource',
    'resource_id', 'order_id', 'afeta_reputacao', 'prazo', 'resolvida', 'resolucao', 'beneficiou', 'acao_disponivel',
    'destinatario', 'prazo_resposta', 'total_mensagens', 'moderadas', 'historico_ml', 'criado_em', 'atualizado_em_ml'];

const agora = () => new Date().toISOString();
function ler() { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return {}; } }
function gravar(d) {
    fs.mkdirSync(STORAGE, { recursive: true });
    const tmp = ARQ + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1), 'utf8');
    fs.renameSync(tmp, ARQ);
}

// Insere/atualiza o que veio do ML preservando analise, resposta e status local.
function salvarRegistro(reg) {
    const d = ler();
    const id = String(reg.mediacao_id);
    const atual = d[id] || { mediacao_id: id, status: 'pendente', prioridade: 'media', score: 0, analise: {}, mensagem_sugerida: '', criado_local: agora() };
    for (const k of CAMPOS_ML) atual[k] = reg[k];
    atual.sincronizado_em = agora();
    // sem acao liberada pelo ML (esperando comprador/mediador ou prazo vencido): sai da fila de pendentes
    if (reg.status_ml && reg.status_ml !== 'opened' && ['pendente', 'aguardando'].includes(atual.status)) atual.status = 'encerrada';
    else if (!reg.acao_disponivel && atual.status === 'pendente') atual.status = 'aguardando';
    else if (reg.acao_disponivel && atual.status === 'aguardando') atual.status = 'pendente';
    d[id] = atual;
    gravar(d);
    return atual;
}

function score(a) {
    let s = { alta: 40, media: 22, baixa: 8 }[a.prioridade] ?? 15;
    s += { alto: 30, medio: 15, baixo: 0 }[a.risco_reputacional] ?? 15;
    if (a.acao_recomendada === 'responder') s += 20;
    return Math.min(100, s);
}

function salvarAnalise(id, analise) {
    const d = ler(); if (!d[id]) return;
    d[id].analise = analise;
    d[id].mensagem_sugerida = analise.resposta || '';
    d[id].prioridade = ['alta', 'media', 'baixa'].includes(analise.prioridade) ? analise.prioridade : 'media';
    d[id].score = score(analise);
    d[id].atualizado_em = agora();
    gravar(d);
}
function atualizar(id, campos) {
    const d = ler(); if (!d[id]) return null;
    Object.assign(d[id], campos, { atualizado_em: agora() });
    gravar(d);
    return d[id];
}
function registrarAcao(id, tipo, extra = {}) {
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.appendFileSync(HIST, JSON.stringify({ mediacao_id: String(id), tipo, quando: agora(), ...extra }) + '\n', 'utf8');
}
function historico(id) {
    try {
        return fs.readFileSync(HIST, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(x => x && x.mediacao_id === String(id)).reverse();
    } catch { return []; }
}
const obter = (id) => ler()[String(id)] || null;

function listar({ conta, status } = {}) {
    return Object.values(ler())
        .filter(m => (!conta || m.conta === conta) && (!status || m.status === status))
        .sort((a, b) => (ORDEM[a.prioridade] ?? 1) - (ORDEM[b.prioridade] ?? 1) || (b.score || 0) - (a.score || 0)
            || String(b.atualizado_em_ml || '').localeCompare(String(a.atualizado_em_ml || '')));
}
function resumo(conta) {
    const L = listar({ conta });
    const r = { total: L.length, por_status: {}, por_prioridade: { alta: 0, media: 0, baixa: 0 } };
    for (const m of L) {
        r.por_status[m.status] = (r.por_status[m.status] || 0) + 1;
        if (m.status === 'pendente' && r.por_prioridade[m.prioridade] != null) r.por_prioridade[m.prioridade]++;
    }
    return r;
}

module.exports = { salvarRegistro, salvarAnalise, atualizar, registrarAcao, historico, obter, listar, resumo, STORAGE };
