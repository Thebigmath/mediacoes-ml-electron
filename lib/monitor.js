// Monitor: junta Mercado Livre + IA + banco.
//   sincronizar(conta) -> puxa as mediacoes abertas do ML e grava no banco
//   analisarPendentes  -> gera analise + resposta pronta para as pendentes sem analise
//   agendador          -> a cada 30 min, as duas contas (so leitura no ML); avisa mediacao nova
// Nada vai para o ML sem passar por enviar(), que exige o texto final e registra no historico.
const banco = require('./banco');
const ml = require('./ml');
const ia = require('./ia');
const { CONTAS } = require('./contas');

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
    try {
        for (const c of conta ? [conta] : Object.keys(CONTAS)) {
            try {
                estado.etapa = `Buscando mediações da ${CONTAS[c].nome}…`;
                const regs = await ml.sincronizar(c, 50, (t) => { estado.etapa = `Lendo ${t}`; });
                const abertas = new Set(regs.map(r => r.mediacao_id));
                for (const r of regs) {
                    if (!banco.obter(r.mediacao_id)) novas.push({ ...r });
                    banco.salvarRegistro(r);
                }
                // o que sumiu da lista de abertas foi encerrado no ML
                for (const m of banco.listar({ conta: c })) {
                    if (!abertas.has(m.mediacao_id) && ['pendente', 'auditando', 'aguardando'].includes(m.status)) banco.atualizar(m.mediacao_id, { status: 'encerrada' });
                }
                estado.ultimo[c] = { quando: new Date().toISOString(), abertas: regs.length };
            } catch (e) {
                estado.erros.push(`${CONTAS[c].nome}: ${e.response?.status || ''} ${e.message}`);
            }
        }
        if (analisar) await analisarPendentes(conta);
    } finally { estado.rodando = false; estado.etapa = ''; }
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
            if (a.erro) { estado.erros.push(`${m.mediacao_id}: ${a.erro}`); continue; }
            banco.salvarAnalise(m.mediacao_id, a);
            banco.registrarAcao(m.mediacao_id, 'analise', { modelo: a.modelo });
            feitas++;
        } catch (e) { estado.erros.push(`${m.mediacao_id}: ${e.message}`); }
    }
    return { analisadas: feitas, erros: estado.erros };
}

async function analisarUma(id) {
    const m = banco.obter(id); if (!m) throw new Error('Mediação não encontrada.');
    const a = await ia.analisar(m);
    if (a.erro) throw new Error(a.erro);
    banco.salvarAnalise(id, a);
    banco.registrarAcao(id, 'analise', { modelo: a.modelo });
    return banco.obter(id);
}

async function reescrever(id, tom) {
    const m = banco.obter(id); if (!m) throw new Error('Mediação não encontrada.');
    const r = await ia.reescrever(m, tom);
    banco.registrarAcao(id, 'reescrita', { tom, modelo: r.modelo, texto: r.resposta });
    return r;
}

async function enviar(id, texto, editada) {
    const m = banco.obter(id); if (!m) return { sucesso: false, erro: 'Mediação não encontrada. Atualize a lista.' };
    const r = await ml.enviar(m.conta, String(id), texto, m.order_id || null);
    banco.registrarAcao(id, 'envio', { texto, editada: !!editada, enviou: !!r.sucesso, erro: r.erro || null });
    if (r.sucesso) banco.atualizar(id, { status: 'enviada', resposta_enviada: texto, enviada_em: new Date().toISOString() });
    return r;
}

function iniciarAgendador() {
    pararAgendador();
    // ao ligar o PC: busca logo (20 s para a rede subir), analisa e prepara as respostas
    setTimeout(() => sincronizar().catch(() => {}), 20 * 1000);
    timer = setInterval(() => sincronizar().catch(() => {}), 30 * 60 * 1000);
}
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }

module.exports = { usarAoTerminar, sincronizar, analisarPendentes, analisarUma, reescrever, enviar, estado, iniciarAgendador, pararAgendador, usarNotificador };
