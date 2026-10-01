// Logs do app: um evento por linha em storage/logs/AAAA-MM-DD.jsonl (guarda 30 dias) e os
// ultimos 2000 em memoria para a Area do desenvolvedor.
// Cada evento tem um CODIGO; o dicionario EXPLICA diz, em portugues simples, o que ele
// significa e o que fazer. Codigo sem explicacao cai numa explicacao generica pelo nivel.
const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const PASTA = path.join(STORAGE, 'logs');
const MEMORIA = [];
const MAX = 2000;
let seq = 0;

const EXPLICA = {
    APP_INICIO: { titulo: 'App iniciado', explicacao: 'O app abriu e o servidor interno começou a funcionar.', acao: 'Nada a fazer.' },
    SYNC_INICIO: { titulo: 'Busca de mediações iniciada', explicacao: 'O app começou a buscar no Mercado Livre as mediações abertas (automático a cada 30 min ou pelo botão Atualizar).', acao: 'Nada a fazer; aguarde o SYNC_FIM.' },
    SYNC_CONTA_OK: { titulo: 'Conta lida no Mercado Livre', explicacao: 'As mediações abertas desta conta foram lidas, com conversa e reputação de cada uma.', acao: 'Nada a fazer.' },
    SYNC_CONTA_ERRO: { titulo: 'Falha ao ler uma conta', explicacao: 'O Mercado Livre não respondeu ou recusou a leitura das mediações desta conta. As mediações já salvas continuam na tela.', acao: 'Veja o detalhe: 401/403 = token (abra o Dashboard dessa conta para renovar); 429 = muitas chamadas, tente em alguns minutos; sem código = internet.' },
    SYNC_NOVA: { titulo: 'Mediação nova', explicacao: 'Chegou uma mediação que ainda não estava no app. O painel lateral e a notificação do Windows avisam.', acao: 'Abra a mediação e revise a resposta preparada.' },
    SYNC_ENCERRADA: { titulo: 'Mediação encerrada no ML', explicacao: 'A mediação saiu da lista de abertas do Mercado Livre (o ML decidiu ou o prazo acabou). Ela fica no filtro "Encerradas no ML".', acao: 'Nada a fazer.' },
    SYNC_FIM: { titulo: 'Busca de mediações terminada', explicacao: 'A busca terminou. O detalhe mostra quantas mediações estão abertas por conta e quantas são novas.', acao: 'Nada a fazer.' },
    IA_ANALISE_OK: { titulo: 'IA preparou a resposta', explicacao: 'O Gemini analisou a mediação e escreveu a resposta pronta, com prioridade e defesa.', acao: 'Revise a resposta antes de enviar.' },
    IA_SEM_ACAO: { titulo: 'Mediação sem resposta liberada', explicacao: 'O Mercado Livre não está aceitando resposta nesta mediação agora (esperando o comprador ou o mediador, ou prazo vencido). A IA não gasta cota com ela.', acao: 'Nada a fazer; ela volta para Pendentes quando o ML liberar.' },
    IA_ERRO: { titulo: 'IA não conseguiu analisar', explicacao: 'O Gemini não respondeu ou devolveu algo fora do formato. A mediação fica sem resposta pronta.', acao: '429/quota = a cota gratuita do dia acabou, tente mais tarde; 400/403 = confira a chave em Configurações; outro = use "Refazer análise".' },
    IA_REESCRITA: { titulo: 'Resposta reescrita', explicacao: 'A resposta foi reescrita em outro tom (firme, conciliador ou técnico). Nada foi enviado.', acao: 'Revise e salve.' },
    ENVIO_OK: { titulo: 'Resposta enviada ao ML', explicacao: 'A resposta foi aceita pelo Mercado Livre, depois de conferir que a conta é a vendedora e que o pedido não mudou.', acao: 'Nada a fazer.' },
    ENVIO_RECUSADO: { titulo: 'Envio não feito', explicacao: 'O app ou o Mercado Livre bloqueou o envio. O app sempre bloqueia quando a conta não é a vendedora, o pedido mudou, a mediação foi encerrada ou o ML não libera resposta.', acao: 'Leia o motivo. 400 = o ML recusou o texto (veja a resposta do ML nos detalhes); 403 = a conta não tem acesso; 409 = já enviada ou mudou, atualize a lista; 405 = endereço de envio errado (corrigido na versão 1.0.3).' },
    TOKEN_RENOVADO: { titulo: 'Token do ML renovado', explicacao: 'O acesso ao ML tinha vencido e foi renovado no mesmo arquivo do app Dashboard da conta (sem cópia que brigue com o Dashboard).', acao: 'Nada a fazer.' },
    TOKEN_ERRO: { titulo: 'Problema com o token do ML', explicacao: 'O app não conseguiu usar ou renovar o acesso ao Mercado Livre desta conta.', acao: 'Abra o app Dashboard dessa conta (ele renova o token). Se continuar, gere o token de novo pelo Dashboard.' },
    API_ERRO: { titulo: 'Erro numa tela do app', explicacao: 'Uma ação da tela falhou no servidor interno do app.', acao: 'Veja o detalhe; se repetir, mande este log para o desenvolvedor.' },
    DEV_COMANDO: { titulo: 'Comando no terminal', explicacao: 'Um comando foi digitado no terminal da Área do desenvolvedor.', acao: 'Nada a fazer.' },
    UPDATE: { titulo: 'Atualização do app', explicacao: 'O app verificou, baixou ou instalou uma versão nova pelo GitHub.', acao: 'Nada a fazer.' },
};
const GENERICO = {
    info: { titulo: 'Funcionamento normal', explicacao: 'Registro de algo que aconteceu como esperado.', acao: 'Nada a fazer.' },
    aviso: { titulo: 'Atenção', explicacao: 'Algo não saiu como o ideal, mas o app continuou funcionando.', acao: 'Acompanhe; se repetir muito, investigue.' },
    erro: { titulo: 'Erro', explicacao: 'Uma parte do app falhou nesta tentativa.', acao: 'Leia o detalhe. Se repetir, mande este log para o desenvolvedor.' },
};
const explicar = (e) => EXPLICA[e.codigo] || GENERICO[e.nivel] || GENERICO.info;

function hoje() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function registrar(area, nivel, codigo, mensagem, dados) {
    const e = { id: ++seq, quando: new Date().toISOString(), area, nivel, codigo, mensagem: String(mensagem || ''), dados: dados || null };
    MEMORIA.push(e);
    if (MEMORIA.length > MAX) MEMORIA.shift();
    try { fs.mkdirSync(PASTA, { recursive: true }); fs.appendFileSync(path.join(PASTA, hoje() + '.jsonl'), JSON.stringify(e) + '\n', 'utf8'); } catch {}
    return e;
}
const info = (area, codigo, msg, dados) => registrar(area, 'info', codigo, msg, dados);
const aviso = (area, codigo, msg, dados) => registrar(area, 'aviso', codigo, msg, dados);
const erro = (area, codigo, msg, dados) => registrar(area, 'erro', codigo, msg, dados);

// Carrega o arquivo de hoje ao abrir (para os logs nao sumirem a cada reinicio) e apaga > 30 dias.
function iniciar() {
    try {
        const f = path.join(PASTA, hoje() + '.jsonl');
        if (fs.existsSync(f)) {
            for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX)) {
                try { const e = JSON.parse(l); MEMORIA.push(e); seq = Math.max(seq, e.id || 0); } catch {}
            }
        }
        const limite = Date.now() - 30 * 86400000;
        for (const n of fs.readdirSync(PASTA)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && new Date(n.slice(0, 10)).getTime() < limite) fs.unlinkSync(path.join(PASTA, n));
    } catch {}
}

function listar({ area, nivel, desde = 0, limite = 300 } = {}) {
    return MEMORIA.filter(e => e.id > desde && (!area || e.area === area) && (!nivel || e.nivel === nivel)).slice(-limite)
        .map(e => ({ ...e, explicacao: explicar(e) }));
}

module.exports = { registrar, info, aviso, erro, listar, iniciar, explicar, EXPLICA, PASTA };
