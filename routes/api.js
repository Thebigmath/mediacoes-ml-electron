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

router.get('/contas', async (req, res) => {
    res.json(await Promise.all(Object.keys(contas.CONTAS).map(c => contas.status(c))));
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
    const m = banco.atualizar(req.params.id, { mensagem_sugerida: String((req.body || {}).texto || ''), status: 'auditando' });
    if (!m) return res.status(404).json({ erro: 'Mediação não encontrada.' });
    banco.registrarAcao(req.params.id, 'edicao');
    res.json({ ok: true });
});
router.post('/mediacao/:id/enviar', (req, res) => {
    const b = req.body || {};
    if (b.confirmacao !== 'ENVIAR') return res.status(400).json({ sucesso: false, erro: 'Confirmação ausente.' });
    monitor.enviar(req.params.id, b.texto, b.editada).then(r => res.status(r.sucesso ? 200 : 400).json(r)).catch(erro(res));
});

router.post('/chat', (req, res) => {
    const b = req.body || {};
    if (!String(b.mensagem || '').trim()) return res.status(400).json({ erro: 'Mensagem vazia.' });
    // a senha da Area do desenvolvedor nunca vai para a IA
    const todo = [b.mensagem, ...(b.historico || []).map(h => h && h.content)].join(' ');
    if (senha.contemSenha(todo)) { log.aviso('dev', 'IA_BLOQUEADA', 'Mensagem com dado protegido não foi enviada para a IA'); return res.status(400).json({ erro: 'Essa mensagem contém um dado protegido e não foi enviada para a IA.' }); }
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
let iaMetricas = {};   // ultima analise por periodo/conta (na memoria)
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
    ia.analisarMetricas(r).then(a => { iaMetricas[`${dias}|${conta || ''}`] = a; log.info('ia', 'IA_METRICAS', `Análise das métricas (${dias} dias)`, { modelo: a.modelo }); res.json(a); })
        .catch(e => { log.erro('ia', 'IA_ERRO', `Métricas: ${e.message}`); res.status(500).json({ erro: e.message }); });
});

module.exports = router;
