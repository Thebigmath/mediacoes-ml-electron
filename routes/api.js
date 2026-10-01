const express = require('express');
const fs = require('fs');
const path = require('path');
const banco = require('../lib/banco');
const monitor = require('../lib/monitor');
const contas = require('../lib/contas');
const ia = require('../lib/ia');
const log = require('../lib/log');
const dev = require('../lib/dev');

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
router.get('/dev/logs', (req, res) => res.json(log.listar({ area: req.query.area || undefined, nivel: req.query.nivel || undefined,
    desde: Number(req.query.desde) || 0, limite: Number(req.query.limite) || 300 })));
router.post('/dev/cmd', (req, res) => dev.executar((req.body || {}).linha).then(l => res.json({ linhas: l })).catch(erro(res)));
router.get('/dev/comandos', (req, res) => res.json(Object.entries(dev.COMANDOS).map(([k, v]) => ({ comando: k, ajuda: v.ajuda }))));

module.exports = router;
