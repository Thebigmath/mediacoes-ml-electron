// Analise da IA do relatorio "Quebrados no caminho" (Metricas). Os numeros sao calculados em
// metricas.quebrados(); o Gemini so interpreta e devolve blocos fixos (JSON). Gerada uma vez por dia
// junto com a coleta automatica e guardada em metricas_quebrados_ia.json (por periodo e conta).
const fs = require('fs');
const path = require('path');
const ia = require('./ia');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'metricas_quebrados_ia.json');
const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return {}; } };
const chave = (q) => `${q.dias}|${q.conta || ''}`;

const SISTEMA = `Voce e o analista de pos-venda de um vendedor de autopecas no Mercado Livre (lanternas, tapetes, retrovisores),
contas Flavia Stock e Cordeiro Car. Voce recebe NUMEROS JA CALCULADOS das reclamacoes de produto que chegou quebrado.
Definicoes: "caixa intacta" = a caixa chegou bem e o produto quebrado (a embalagem interna nao segurou: problema NOSSO de embalagem);
"caixa danificada" = a caixa chegou amassada/rasgada (transporte). Prejuizo bruto = custo do produto + frete que pagamos;
reembolso do ML = o que o ML cobriu (cobertura); prejuizo liquido = bruto - reembolso do ML.
Nunca invente numero: use so os dados. Cite valores em R$. Portugues do Brasil, direto. Responda SOMENTE com o JSON pedido.`;

async function analisar(q) {
    const dados = {
        periodo_dias: q.dias, reclamacoes_de_quebra: q.total, caixa_intacta: q.caixa_intacta, caixa_danificada: q.caixa_danificada,
        comprador_ganhou: q.comprador_ganhou, vendedor_ganhou: q.vendedor_ganhou, com_cobertura_ml: q.com_cobertura_ml,
        custo_dos_produtos: q.custo_produtos, frete_pago: q.frete_pago, prejuizo_bruto: q.prejuizo_bruto,
        reembolso_do_ml: q.reembolso_ml, prejuizo_liquido: q.prejuizo_liquido, casos_sem_custo_na_planilha: q.sem_custo,
        por_conta: q.por_conta, por_mes: q.meses,
        produtos: q.produtos.slice(0, 12).map(p => ({ produto: p.produto, sku: p.sku, reclamacoes: p.qtd, perdidas: p.perdidas, caixa_intacta: p.caixa_intacta, prejuizo_liquido: p.prejuizo_liquido, reembolso_ml: p.reembolso_ml })),
    };
    const { texto, modelo } = await ia.gerar(`NUMEROS (JSON):
${JSON.stringify(dados)}

Responda com este JSON exato:
{
 "resumo": "3 a 4 linhas: o quadro geral com os numeros (quantas quebras, quanto perdemos, quanto o ML devolveu)",
 "dinheiro": "1 a 2 linhas: prejuizo bruto, reembolso do ML e prejuizo liquido, e o que isso significa por mes",
 "tendencia": "1 a 2 linhas: o que os meses mostram (subindo, caindo, estavel), com numeros",
 "causas": [{"causa": "...", "evidencia": "numero que mostra"}],
 "produtos_criticos": [{"produto": "nome curto + SKU", "problema": "1 linha com numero", "acao": "o que fazer com a embalagem ou o anuncio"}],
 "embalagem": ["recomendacao pratica de embalagem, ligada aos produtos/numeros"],
 "recuperar_dinheiro": ["como recuperar ou evitar perda: cobertura do ML, contestacao, fotos de expedicao etc., ligado aos numeros"],
 "alertas": ["o que precisa de atencao imediata"]
}
No maximo 5 causas, 6 produtos criticos, 5 recomendacoes de embalagem, 4 de recuperar dinheiro e 4 alertas, ordenados por dinheiro.`, 0.3, SISTEMA, 'metricas_quebrados');
    const r = ia.json(texto);
    r.modelo = modelo; r.analisado_em = new Date().toISOString();
    return r;
}

async function gerarESalvar(q) {
    if (!q.total) return null;
    const r = await analisar(q);
    const d = ler(); d[chave(q)] = r;
    fs.mkdirSync(STORAGE, { recursive: true });
    fs.writeFileSync(ARQ, JSON.stringify(d, null, 1), 'utf8');
    return r;
}
const ultima = (q) => ler()[chave(q)] || null;

module.exports = { gerarESalvar, ultima };
