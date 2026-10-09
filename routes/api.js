const express = require('express');
const fs = require('fs');
const path = require('path');
const banco = require('../lib/banco');
const monitor = require('../lib/monitor');
const contas = require('../lib/contas');
const ia = require('../lib/ia');
const log = require('../lib/log');
const dev = require('../lib/dev');
const senha = require('../lib/senha');

const router = express.Router();
const erro = (res) => (e) => { log.erro('app', 'API_ERRO', e.message); res.status(500).json({ erro: e.message }); };
const STORAGE = banco.STORAGE;
const CONFIG = path.join(STORAGE, 'config.json');
const lerCfg = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };

router.get('/versao', (req, res) => res.json({ versao: require('../package.json').version }));

// Saude do Harvey: uma tela que diz se esta tudo pronto para trabalhar (contas, IA, buscas, uso).
// So leitura. A chave do Gemini e conferida listando os modelos (nao gasta cota), com cache de 10 min.
let cacheGemini = { t: 0, r: null };
async function saudeGemini() {
    if (Date.now() - cacheGemini.t < 10 * 60 * 1000 && cacheGemini.r) return cacheGemini.r;
    let k = null, r;
    try { k = ia.chave(); } catch {}
    const origem = lerCfg().gemini_api_key ? 'Configurações' : 'arquivo da Área de Trabalho';
    if (!k) r = { ok: false, texto: 'sem chave do Gemini: cole a chave abaixo' };
    else {
        try {
            await require('axios').get('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': k }, params: { pageSize: 1 }, timeout: 15000 });
            r = { ok: true, texto: `chave aceita (termina em ${k.slice(-4)}, de ${origem})` };
        } catch (e) { r = { ok: false, texto: `o Google recusou a chave (${e.response?.status || e.message})` }; }
    }
    cacheGemini = { t: Date.now(), r };
    return r;
}
router.get('/saude', async (req, res) => {
    const perguntas = require('../lib/perguntas');
    const [cs, gemini, ollama] = await Promise.all([
        Promise.all(Object.keys(contas.CONTAS).map(c => contas.status(c))),
        saudeGemini(),
        require('axios').get('http://127.0.0.1:11434/api/tags', { timeout: 3000 }).then(r => ({ ok: true, texto: `ligado (${(r.data.models || []).map(m => m.name).join(', ') || 'sem modelo'})` }))
            .catch(() => ({ ok: null, texto: 'não instalado (opcional: só reserva do Gemini)' })),
    ]);
    const ult = monitor.estado.ultimo || {};
    const ultimaBusca = Object.values(ult).map(u => u.quando).sort().pop() || null;
    const hoje = (ia.usoIA(1)[0] || {});
    const erroRecente = log.listar({ nivel: 'erro', limite: 1 })[0] || null;
    res.json({
        versao: require('../package.json').version,
        contas: cs.map(c => ({ nome: c.nome, ok: c.conectado, texto: c.conectado ? `conectada como ${c.apelido || c.seller_id} (${c.modo === 'proprio' ? 'app próprio' : 'token do Dashboard'})` : c.erro })),
        gemini, ollama,
        mediacoes: { ok: ultimaBusca ? !monitor.estado.erros.length : null, texto: ultimaBusca ? `última busca ${new Date(ultimaBusca).toLocaleString('pt-BR')}${monitor.estado.erros.length ? ' · com erro: ' + monitor.estado.erros[0] : ''}` : 'aguardando a 1ª busca (começa 20 s depois de abrir o app)' },
        perguntas: { ok: perguntas.estado.verificado_em ? !perguntas.estado.erros.length : null, texto: perguntas.estado.verificado_em ? `última verificação ${new Date(perguntas.estado.verificado_em).toLocaleString('pt-BR')} · resposta automática ${perguntas.automatico() ? 'LIGADA' : 'desligada'}` : 'aguardando a 1ª verificação (a cada 2 min)' },
        uso_hoje: { gemini: hoje.dia ? hoje.gemini : 0, ollama: hoje.dia ? hoje.ollama : 0, erros: hoje.dia ? hoje.erros : 0 },
        erro_recente: erroRecente ? { quando: erroRecente.quando, texto: `[${erroRecente.area}] ${erroRecente.mensagem}` } : null,
    });
});
router.get('/uso', (req, res) => res.json(ia.usoIA(Number(req.query.dias) || 30)));

router.get('/contas', async (req, res) => {
    res.json(await Promise.all(Object.keys(contas.CONTAS).map(async c => ({ ...(await contas.status(c)), app: contas.appInfo(c) }))));
});
// App proprio do ML por conta (o client_secret entra aqui e nunca mais volta para a tela)
const contaValida = (req, res) => { if (!contas.CONTAS[req.params.conta]) { res.status(404).json({ erro: 'Conta desconhecida.' }); return false; } return true; };
router.post('/contas/:conta/app', (req, res) => {
    if (!contaValida(req, res)) return;
    try { contas.configurarApp(req.params.conta, req.body || {}); res.json({ ok: true, url: contas.urlAutorizacao(req.params.conta) }); }
    catch (e) { res.status(400).json({ erro: e.message }); }
});
router.get('/contas/:conta/autorizar', (req, res) => {
    if (!contaValida(req, res)) return;
    try { res.json({ url: contas.urlAutorizacao(req.params.conta) }); } catch (e) { res.status(400).json({ erro: e.message }); }
});
router.post('/contas/:conta/codigo', (req, res) => {
    if (!contaValida(req, res)) return;
    contas.trocarCodigo(req.params.conta, (req.body || {}).codigo).then(r => res.json({ ok: true, ...r }))
        .catch(e => { log.aviso('token', 'CONEXAO_RECUSADA', `${contas.CONTAS[req.params.conta].nome}: ${e.message}`); res.status(400).json({ erro: e.message }); });
});
router.post('/contas/:conta/desconectar', (req, res) => {
    if (!contaValida(req, res)) return;
    contas.desconectar(req.params.conta); res.json({ ok: true });
});

router.get('/painel', (req, res) => {
    const conta = req.query.conta || undefined;
    const itens = banco.listar({ conta }).map(m => ({
        mediacao_id: m.mediacao_id, conta: m.conta, tema: m.tema, prioridade: m.prioridade, score: m.score, status: m.status,
        pergunta_original: m.pergunta_original, afeta_reputacao: m.afeta_reputacao, prazo_resposta: m.prazo_resposta || m.prazo,
        acao_disponivel: m.acao_disponivel, total_mensagens: m.total_mensagens, resumo: (m.analise || {}).resumo || '',
        acao_recomendada: (m.analise || {}).acao_recomendada || '', tem_resposta: !!m.mensagem_sugerida,
        moderadas: (m.moderadas || []).length, atualizado_em_ml: m.atualizado_em_ml, order_id: m.order_id,
    }));
    res.json({ resumo: banco.resumo(conta), itens, estado: monitor.estado });
});

router.get('/mediacao/:id/anexo/:arquivo', async (req, res) => {
    const m = banco.obter(req.params.id); if (!m) return res.status(404).end();
    const ok = (m.historico_ml || []).some(x => (x.anexos || []).some(a => a.arquivo === req.params.arquivo));   // so anexos desta mediacao
    if (!ok) return res.status(404).end();
    try { const a = await require('../lib/ml').baixarAnexo(m.conta, m.mediacao_id, req.params.arquivo); res.set('Content-Type', a.tipo).set('Cache-Control', 'private, max-age=3600').send(a.dados); }
    catch (e) { res.status(502).end(); }
});
router.get('/mediacao/:id', (req, res) => {
    const m = banco.obter(req.params.id);
    if (!m) return res.status(404).json({ erro: 'Mediação não encontrada.' });
    res.json({ mediacao: m, historico: banco.historico(req.params.id) });
});

router.post('/sincronizar', (req, res) => {
    if (monitor.estado.rodando) return res.json({ ok: false, erro: 'Já existe uma atualização em andamento.' });
    monitor.sincronizar(req.body && req.body.conta).catch(() => {});
    res.json({ ok: true });
});
router.get('/estado', (req, res) => res.json(monitor.estado));

router.post('/mediacao/:id/atualizar', (req, res) => monitor.atualizarUma(req.params.id).then(m => res.json({ ok: true, mediacao: m })).catch(erro(res)));
router.post('/mediacao/:id/analisar', (req, res) => monitor.analisarUma(req.params.id).then(m => res.json({ ok: true, mediacao: m })).catch(erro(res)));
router.post('/mediacao/:id/reescrever', (req, res) => monitor.reescrever(req.params.id, (req.body || {}).tom).then(r => res.json(r)).catch(erro(res)));
router.post('/mediacao/:id/rascunho', (req, res) => {
    const m = banco.atualizar(req.params.id, { mensagem_sugerida: String((req.body || {}).texto || ''), status: 'auditando', rascunho_em: new Date().toISOString() });
    if (!m) return res.status(404).json({ erro: 'Mediação não encontrada.' });
    banco.registrarAcao(req.params.id, 'edicao');
    res.json({ ok: true });
});
// Ignorar: tira da fila so neste app (nada e enviado ao ML). Volta sozinha se chegar mensagem nova.
router.post('/mediacao/:id/ignorar', (req, res) => {
    const m = banco.atualizar(req.params.id, { status: 'ignorada', ignorada_em: new Date().toISOString() });
    if (!m) return res.status(404).json({ erro: 'Mediação não encontrada.' });
    banco.registrarAcao(req.params.id, 'ignorada'); res.json({ ok: true });
});
router.post('/mediacao/:id/reabrir', (req, res) => {
    const m = banco.atualizar(req.params.id, { status: (banco.obter(req.params.id) || {}).acao_disponivel ? 'pendente' : 'aguardando' });
    if (!m) return res.status(404).json({ erro: 'Mediação não encontrada.' });
    banco.registrarAcao(req.params.id, 'reaberta'); res.json({ ok: true });
});
// Aprendizado: perguntas ja respondidas pela equipe no ML, usadas como exemplo pela IA
router.get('/perguntas/aprendizado', (req, res) => res.json(require('../lib/aprendizado').estado()));
router.post('/perguntas/aprendizado', (req, res) => require('../lib/aprendizado').sincronizar().then(() => res.json(require('../lib/aprendizado').estado())).catch(erro(res)));
router.post('/mediacao/:id/enviar', (req, res) => {
    const b = req.body || {};
    if (b.confirmacao !== 'ENVIAR') return res.status(400).json({ sucesso: false, erro: 'Confirmação ausente.' });
    monitor.enviar(req.params.id, b.texto, b.editada).then(r => res.status(r.sucesso ? 200 : 400).json(r)).catch(erro(res));
});

router.post('/chat', async (req, res) => {
    const b = req.body || {};
    if (!String(b.mensagem || '').trim()) return res.status(400).json({ erro: 'Mensagem vazia.' });
    // a senha da Area do desenvolvedor nunca vai para a IA. So a mensagem nova e conferida: o historico
    // e feito de mensagens que ja passaram por aqui (ou respostas da IA, que nunca recebeu a senha).
    if (await senha.contemSenha(b.mensagem)) { log.aviso('dev', 'IA_BLOQUEADA', 'Mensagem com dado protegido não foi enviada para a IA'); return res.status(400).json({ erro: 'Essa mensagem contém um dado protegido e não foi enviada para a IA.' }); }
    ia.conversar(String(b.mensagem), b.historico || []).then(r => res.json({ resposta: r })).catch(erro(res));
});

// Configuracoes (a chave do Gemini nunca volta inteira para a tela)
router.get('/config', (req, res) => {
    const c = lerCfg();
    res.json({ gemini_configurado: !!c.gemini_api_key, gemini_final: c.gemini_api_key ? c.gemini_api_key.slice(-4) : '', ollama_modelo: c.ollama_modelo || 'llama3.2' });
});
router.post('/config', (req, res) => {
    const c = lerCfg(); const b = req.body || {};
    if (typeof b.gemini_api_key === 'string' && b.gemini_api_key.trim()) c.gemini_api_key = b.gemini_api_key.trim();
    if (b.remover_gemini) delete c.gemini_api_key;
    if (typeof b.ollama_modelo === 'string' && b.ollama_modelo.trim()) c.ollama_modelo = b.ollama_modelo.trim();
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), 'utf8');
    res.json({ ok: true });
});

// Area do desenvolvedor: logs e terminal
router.post('/dev/entrar', (req, res) => {
    const r = senha.entrar(String((req.body || {}).senha || ''));
    if (r.ok) log.info('dev', 'DEV_ENTROU', 'Área do desenvolvedor desbloqueada');
    else log.aviso('dev', 'DEV_SENHA_ERRADA', r.erro);   // a senha digitada nunca vai para o log
    res.status(r.ok ? 200 : 401).json(r);
});
router.post('/dev/sair', (req, res) => { senha.sair(req.get('x-dev-token')); res.json({ ok: true }); });
router.use('/dev', senha.exigir);   // tudo abaixo de /api/dev exige a sessao
router.get('/dev/logs', (req, res) => res.json(log.listar({ area: req.query.area || undefined, nivel: req.query.nivel || undefined,
    desde: Number(req.query.desde) || 0, limite: Number(req.query.limite) || 300 })));
router.post('/dev/cmd', (req, res) => dev.executar((req.body || {}).linha).then(r => res.json(Array.isArray(r) ? { linhas: r } : r)).catch(erro(res)));
router.get('/dev/comandos', (req, res) => res.json(Object.entries(dev.COMANDOS).map(([k, v]) => ({ comando: k, ajuda: v.ajuda }))));

// Metricas de reclamacoes encerradas + analise da IA
const metricas = require('../lib/metricas');
// ultima analise da IA por periodo/conta, salva em metricas_ia.json (antes ficava so na memoria e sumia ao fechar)
const ARQ_IA_MET = path.join(STORAGE, 'metricas_ia.json');
let iaMetricas = (() => { try { return JSON.parse(fs.readFileSync(ARQ_IA_MET, 'utf8')); } catch { return {}; } })();
const salvarIaMet = () => { try { fs.writeFileSync(ARQ_IA_MET, JSON.stringify(iaMetricas, null, 1), 'utf8'); } catch {} };
router.get('/metricas', (req, res) => {
    const dias = Number(req.query.dias) || 90; const conta = req.query.conta || undefined;
    res.json({ ...metricas.resumo({ dias, conta }), ia: iaMetricas[`${dias}|${conta || ''}`] || null });
});
router.post('/metricas/atualizar', (req, res) => {
    const dias = Number((req.body || {}).dias) || 90;
    metricas.coletar(Math.max(dias, 90)).then(() => res.json({ ok: true })).catch(erro(res));
});
router.post('/metricas/ia', (req, res) => {
    const dias = Number((req.body || {}).dias) || 90; const conta = (req.body || {}).conta || undefined;
    const r = metricas.resumo({ dias, conta });
    if (!r.total) return res.status(400).json({ erro: 'Sem reclamações no período. Clique em Atualizar métricas primeiro.' });
    ia.analisarMetricas(r).then(a => { iaMetricas[`${dias}|${conta || ''}`] = a; salvarIaMet(); log.info('ia', 'IA_METRICAS', `Análise das métricas (${dias} dias)`, { modelo: a.modelo }); res.json(a); })
        .catch(e => { log.erro('ia', 'IA_ERRO', `Métricas: ${e.message}`); res.status(500).json({ erro: e.message }); });
});

// Dashboard HTML das metricas (com a analise da IA, se houver; com "comIA" gera a analise se faltar).
// Salva em Downloads e devolve o caminho para a tela abrir.
router.post('/metricas/relatorio', async (req, res) => {
    try {
        const b = req.body || {}; const dias = Number(b.dias) || 90; const conta = b.conta || undefined;
        const r = metricas.resumo({ dias, conta });
        if (!r.total) return res.status(400).json({ erro: 'Sem reclamações no período. Clique em Atualizar métricas primeiro.' });
        const chave = `${dias}|${conta || ''}`;
        if (b.comIA && !iaMetricas[chave]) { iaMetricas[chave] = await ia.analisarMetricas(r); salvarIaMet(); }
        const html = require('../lib/relatorio').gerar(r, iaMetricas[chave] || null, { versao: require('../package.json').version });
        const pasta = path.join(require('os').homedir(), 'Downloads');
        fs.mkdirSync(pasta, { recursive: true });
        const d = new Date(), z = (n) => String(n).padStart(2, '0');
        const arquivo = path.join(pasta, `Harvey_reclamacoes_${dias}d${conta ? '_' + conta : ''}_${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}.html`);
        fs.writeFileSync(arquivo, html, 'utf8');
        log.info('metricas', 'RELATORIO_HTML', `Dashboard gerado: ${path.basename(arquivo)}`, { com_ia: !!iaMetricas[chave] });
        res.json({ ok: true, arquivo, com_ia: !!iaMetricas[chave] });
    } catch (e) { log.erro('metricas', 'RELATORIO_ERRO', e.message); res.status(500).json({ erro: e.message }); }
});

// Perguntas de pre-venda
const perguntas = require('../lib/perguntas');
router.get('/perguntas', (req, res) => res.json(perguntas.listar()));
router.post('/perguntas/verificar', (req, res) => { perguntas.verificar().catch(() => {}); res.json({ ok: true }); });
router.post('/perguntas/automatico', (req, res) => { perguntas.setAutomatico(!!(req.body || {}).ligado); log.info('perguntas', 'PERG_MODO', `Resposta automática ${(req.body || {}).ligado ? 'ligada' : 'desligada'}`); res.json({ ok: true, automatico: perguntas.automatico() }); });
router.post('/perguntas/:id/responder', (req, res) => perguntas.responder(req.params.id, (req.body || {}).texto).then(r => res.json({ ok: true, pergunta: r })).catch(e => res.status(400).json({ erro: e.message })));
router.post('/perguntas/:id/gerar', (req, res) => perguntas.gerarDeNovo(req.params.id).then(r => res.json({ ok: true, pergunta: r })).catch(erro(res)));
router.post('/perguntas/:id/ignorar', (req, res) => { perguntas.ignorar(req.params.id); res.json({ ok: true }); });

module.exports = router;
