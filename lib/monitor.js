// Monitor: junta Mercado Livre + IA + banco.
//   sincronizar(conta) -> puxa as mediacoes abertas do ML e grava no banco
//   analisarPendentes  -> gera analise + resposta pronta para as pendentes sem analise
//   agendador          -> a cada 30 min, as duas contas (so leitura no ML); avisa mediacao nova
// Nada vai para o ML sem passar por enviar(), que exige o texto final e registra no historico.
const banco = require('./banco');
const ml = require('./ml');
const ia = require('./ia');
const { CONTAS } = require('./contas');
const log = require('./log');

let notificar = () => {};
let aoTerminar = () => {};   // avisa o processo principal (painel lateral) ao fim de cada busca
const estado = { rodando: false, etapa: '', ultimo: {}, erros: [] };
let timer = null;

function usarNotificador(fn) { notificar = fn; }
function usarAoTerminar(fn) { aoTerminar = fn; }

async function sincronizar(conta, { analisar = true } = {}) {
    if (estado.rodando) return { ok: false, erro: 'Já existe uma atualização em andamento.' };
    estado.rodando = true; estado.erros = [];
    const novas = [];
    const t0 = Date.now();
    log.info('sync', 'SYNC_INICIO', `Buscando mediações ${conta ? 'da ' + CONTAS[conta].nome : 'das duas contas'}`);
    try {
        for (const c of conta ? [conta] : Object.keys(CONTAS)) {
            try {
                estado.etapa = `Buscando mediações da ${CONTAS[c].nome}…`;
                const regs = await ml.sincronizar(c, 50, (t) => { estado.etapa = `Lendo ${t}`; });
                const abertas = new Set(regs.map(r => r.mediacao_id));
                for (const r of regs) {
                    if (!banco.obter(r.mediacao_id)) { novas.push({ ...r }); log.info('sync', 'SYNC_NOVA', `${CONTAS[c].nome}: ${r.tema}`, { mediacao: r.mediacao_id, pedido: r.order_id }); }
                    banco.salvarRegistro(r);
                }
                // o que sumiu da lista de abertas foi encerrado no ML
                for (const m of banco.listar({ conta: c })) {
                    if (!abertas.has(m.mediacao_id) && ['pendente', 'auditando', 'aguardando'].includes(m.status)) {
                        banco.atualizar(m.mediacao_id, { status: 'encerrada' });
                        log.info('sync', 'SYNC_ENCERRADA', `${CONTAS[c].nome}: ${m.tema}`, { mediacao: m.mediacao_id });
                    }
                }
                estado.ultimo[c] = { quando: new Date().toISOString(), abertas: regs.length };
                log.info('sync', 'SYNC_CONTA_OK', `${CONTAS[c].nome}: ${regs.length} mediações abertas`, { abertas: regs.length });
            } catch (e) {
                estado.erros.push(`${CONTAS[c].nome}: ${e.response?.status || ''} ${e.message}`);
                log.erro('sync', 'SYNC_CONTA_ERRO', `${CONTAS[c].nome}: ${e.message}`, { http: e.response?.status || null, resposta: JSON.stringify(e.response?.data || '').slice(0, 300) });
            }
        }
        if (analisar) await analisarPendentes(conta);
    } finally { estado.rodando = false; estado.etapa = ''; }
    log.info('sync', 'SYNC_FIM', `Busca terminada em ${Math.round((Date.now() - t0) / 1000)} s: ${novas.length} nova(s)`, { ultimo: estado.ultimo, novas: novas.length, erros: estado.erros.length });
    if (novas.length) {
        notificar(novas.length === 1 ? 'Nova mediação no Mercado Livre' : `${novas.length} novas mediações no Mercado Livre`,
            novas.slice(0, 3).map(n => `${CONTAS[n.conta].nome}: ${n.tema}`).join('\n'));
    }
    try { aoTerminar({ novas: novas.length }); } catch {}
    return { ok: true, novas: novas.length, erros: estado.erros };
}

async function analisarPendentes(conta, forcar = false) {
    const alvos = banco.listar({ conta, status: 'pendente' }).filter(m => forcar || !m.mensagem_sugerida);
    let feitas = 0;
    for (const [i, m] of alvos.entries()) {
        estado.etapa = `IA analisando ${i + 1} de ${alvos.length}…`;
        try {
            const a = await ia.analisar(m);
            if (a.erro) { log.info('ia', 'IA_SEM_ACAO', `${m.tema}`, { mediacao: m.mediacao_id }); continue; }
            banco.salvarAnalise(m.mediacao_id, a);
            banco.registrarAcao(m.mediacao_id, 'analise', { modelo: a.modelo });
            log.info('ia', 'IA_ANALISE_OK', `${m.tema}: prioridade ${a.prioridade}`, { mediacao: m.mediacao_id, modelo: a.modelo, acao: a.acao_recomendada });
            feitas++;
        } catch (e) {
            estado.erros.push(`${m.mediacao_id}: ${e.message}`);
            log.erro('ia', 'IA_ERRO', `${m.tema}: ${e.message}`, { mediacao: m.mediacao_id });
        }
    }
    return { analisadas: feitas, erros: estado.erros };
}

async function analisarUma(id) {
    const m = banco.obter(id); if (!m) throw new Error('Mediação não encontrada.');
    let a;
    try { a = await ia.analisar(m); } catch (e) { log.erro('ia', 'IA_ERRO', `${m.tema}: ${e.message}`, { mediacao: id }); throw e; }
    if (a.erro) { log.info('ia', 'IA_SEM_ACAO', m.tema, { mediacao: id }); throw new Error(a.erro); }
    banco.salvarAnalise(id, a);
    banco.registrarAcao(id, 'analise', { modelo: a.modelo });
    log.info('ia', 'IA_ANALISE_OK', `${m.tema}: prioridade ${a.prioridade} (pedida na tela)`, { mediacao: id, modelo: a.modelo });
    return banco.obter(id);
}

async function reescrever(id, tom) {
    const m = banco.obter(id); if (!m) throw new Error('Mediação não encontrada.');
    let r;
    try { r = await ia.reescrever(m, tom); } catch (e) { log.erro('ia', 'IA_ERRO', `Reescrita (${tom}): ${e.message}`, { mediacao: id }); throw e; }
    banco.registrarAcao(id, 'reescrita', { tom, modelo: r.modelo, texto: r.resposta });
    log.info('ia', 'IA_REESCRITA', `${m.tema}: tom ${tom}`, { mediacao: id, modelo: r.modelo });
    return r;
}

// Relê uma mediação no ML e grava (ao abrir na tela e logo depois de enviar)
async function atualizarUma(id) {
    const m = banco.obter(id); if (!m) throw new Error('Mediação não encontrada.');
    const r = await ml.atualizarUma(m.conta, String(id));
    return banco.salvarRegistro(r);
}

async function enviar(id, texto, editada) {
    const m = banco.obter(id); if (!m) return { sucesso: false, erro: 'Mediação não encontrada. Atualize a lista.' };
    const r = await ml.enviar(m.conta, String(id), texto, m.order_id || null);
    banco.registrarAcao(id, 'envio', { texto, editada: !!editada, enviou: !!r.sucesso, erro: r.erro || null });
    if (r.sucesso) log.info('envio', 'ENVIO_OK', `${CONTAS[m.conta].nome}: ${m.tema} → ${r.receiver_role === 'mediator' ? 'mediador' : 'comprador'}`, { mediacao: id, pedido: r.pedido });
    else log.aviso('envio', 'ENVIO_RECUSADO', `${CONTAS[m.conta].nome}: ${r.erro}`, { mediacao: id, pedido: m.order_id, http: r.http || null, resposta_ml: r.detalhes || null });
    if (r.sucesso) {
        banco.atualizar(id, { status: 'enviada', resposta_enviada: texto, mensagem_sugerida: '', enviada_em: new Date().toISOString() });
        try { await atualizarUma(id); } catch {}   // traz a mensagem enviada (e a resposta do mediador, se ja veio)
    }
    return r;
}

function iniciarAgendador() {
    pararAgendador();
    // ao ligar o PC: busca logo (20 s para a rede subir), analisa e prepara as respostas
    setTimeout(() => sincronizar().catch(() => {}), 20 * 1000);
    timer = setInterval(() => sincronizar().catch(() => {}), 30 * 60 * 1000);
}
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

module.exports = { atualizarUma, usarAoTerminar, sincronizar, analisarPendentes, analisarUma, reescrever, enviar, estado, iniciarAgendador, pararAgendador, usarNotificador };
