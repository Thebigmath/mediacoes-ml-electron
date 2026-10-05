// Dashboard HTML das metricas de reclamacoes (um arquivo so, abre sem internet, imprime bem).
// Recebe o resumo de metricas.resumo() e, se houver, a analise da IA (ia.analisarMetricas).
// Graficos em SVG/CSS puro, tema claro/escuro automatico.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R$ = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function barras(lista, { rotulo, valor, extra = () => '', max } = {}) {
    if (!lista.length) return '<div class="vazio">Sem dados no período.</div>';
    const m = max || Math.max(...lista.map(valor), 1);
    return lista.map(x => `<div class="barra"><div class="br-top"><span class="br-nome">${esc(rotulo(x))}</span><span class="br-val">${esc(extra(x))}</span></div>
      <div class="br-trilho"><div class="br-ench" style="width:${Math.max(2, (valor(x) / m) * 100)}%"></div></div></div>`).join('');
}

function colunasMes(meses) {
    if (!meses.length) return '';
    const m = Math.max(...meses.map(x => x.qtd), 1), alto = 140;
    const largura = 56, gap = 18, w = meses.length * (largura + gap);
    const cols = meses.map((x, i) => {
        const h = Math.max(4, (x.qtd / m) * alto), xx = i * (largura + gap);
        const [ano, mes] = x.mes.split('-');
        return `<rect x="${xx}" y="${alto - h + 20}" width="${largura}" height="${h}" rx="6" class="col"/>
          <text x="${xx + largura / 2}" y="${alto - h + 14}" class="col-v">${x.qtd}</text>
          <text x="${xx + largura / 2}" y="${alto + 38}" class="col-m">${MES[Number(mes) - 1]}/${ano.slice(2)}</text>
          ${x.prejuizo ? `<text x="${xx + largura / 2}" y="${alto + 54}" class="col-p">${R$(x.prejuizo)}</text>` : ''}`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${alto + 60}" class="meses" role="img" aria-label="Reclamações por mês">${cols}</svg>`;
}

function gerar(r, ia, { geradoEm = new Date(), versao = '' } = {}) {
    const nomeConta = r.conta ? (r.por_conta.find(c => c.conta === r.conta) || {}).nome : 'Flavia Stock e Cordeiro Car';
    const decididas = r.comprador_ganhou + r.vendedor_ganhou + r.dividido;
    const imp = { alto: 'alto', medio: 'medio', baixo: 'baixo' };
    const blocoIA = !ia ? `<section class="card ia"><h2>Análise da IA</h2><div class="vazio">Sem análise da IA para este período. No Harvey, clique em "Analisar com a IA" e gere o dashboard de novo.</div></section>`
        : `<section class="card ia"><h2>Análise da IA <span class="mini">${esc(ia.modelo || '')} · ${new Date(ia.analisado_em).toLocaleString('pt-BR')}</span></h2>
          <p class="lead">${esc(ia.resumo || '')}</p>
          ${ia.prejuizo ? `<p class="sub">${esc(ia.prejuizo)}</p>` : ''}
          ${(ia.alertas || []).length ? `<h3>Atenção</h3><ul class="alertas">${ia.alertas.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
          ${(ia.principais_causas || []).length ? `<h3>Principais causas</h3><ul>${ia.principais_causas.map(c => `<li><b>${esc(c.causa)}</b> — ${esc(c.porque)}</li>`).join('')}</ul>` : ''}
          ${(ia.sugestoes || []).length ? `<h3>Sugestões</h3><div class="sugs">${ia.sugestoes.map(s => `<div class="sug"><div class="sug-h"><b>${esc(s.titulo)}</b><span class="chip ${imp[s.impacto] || ''}">impacto ${esc(s.impacto)}</span></div><div>${esc(s.detalhe)}</div>${s.relacionado ? `<div class="mini">${esc(s.relacionado)}</div>` : ''}</div>`).join('')}</div>` : ''}
        </section>`;

    return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reclamações — ${esc(nomeConta)} — ${r.dias} dias</title>
<style>
:root { --bg:#f4f5f8; --card:#fff; --l1:#16181d; --l2:#4a4f5c; --l3:#7d8292; --sep:#e3e5ea; --ac:#5b59e0; --ac2:#d9d8fb; --verde:#1f9d55; --vermelho:#d93025; --laranja:#d97706; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1116; --card:#181b22; --l1:#f1f2f5; --l2:#b9bdc8; --l3:#858a98; --sep:#2a2e38; --ac:#8f8df7; --ac2:#2c2b52; --verde:#34c759; --vermelho:#ff6b5e; --laranja:#ffa940; } }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--l1); font:14px/1.5 -apple-system,"Segoe UI",Inter,Roboto,sans-serif; }
.wrap { max-width:1100px; margin:0 auto; padding:28px 16px 48px; }
header { display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
h1 { font-size:24px; margin:0; } h2 { font-size:16px; margin:0 0 12px; } h3 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--l3); margin:16px 0 6px; }
.sub { color:var(--l2); } .mini { color:var(--l3); font-size:12px; font-weight:400; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:14px; }
.kpi { background:var(--card); border:1px solid var(--sep); border-radius:14px; padding:14px 16px; }
.kpi .n { font-size:26px; font-weight:800; margin-top:2px; } .kpi .l { color:var(--l3); font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; font-weight:700; }
.kpi.bom .n { color:var(--verde); } .kpi.ruim .n { color:var(--vermelho); }
.grade { display:grid; grid-template-columns:1fr 1fr; gap:14px; } @media (max-width:760px) { .grade { grid-template-columns:1fr; } }
.card { background:var(--card); border:1px solid var(--sep); border-radius:14px; padding:16px 18px; margin-bottom:14px; }
.barra { margin:9px 0; } .br-top { display:flex; justify-content:space-between; gap:10px; font-size:13px; } .br-nome { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .br-val { color:var(--l3); white-space:nowrap; }
.br-trilho { height:8px; background:var(--ac2); border-radius:99px; margin-top:4px; overflow:hidden; } .br-ench { height:100%; background:var(--ac); border-radius:99px; }
.meses { width:100%; max-width:640px; display:block; margin:6px auto 0; } .col { fill:var(--ac); } .col-v { fill:var(--l1); font-size:13px; font-weight:700; text-anchor:middle; } .col-m { fill:var(--l3); font-size:12px; text-anchor:middle; } .col-p { fill:var(--vermelho); font-size:11px; text-anchor:middle; }
.placar { display:flex; height:16px; border-radius:99px; overflow:hidden; margin:10px 0 6px; } .placar div { height:100%; }
.leg { display:flex; gap:14px; flex-wrap:wrap; font-size:12.5px; color:var(--l2); } .leg i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
table { width:100%; border-collapse:collapse; font-size:13px; } th { text-align:left; color:var(--l3); font-size:11px; text-transform:uppercase; letter-spacing:.05em; padding:6px 8px; border-bottom:1px solid var(--sep); } td { padding:7px 8px; border-bottom:1px solid var(--sep); vertical-align:top; } td.n { text-align:right; white-space:nowrap; }
.ia .lead { font-size:15px; } .alertas li { color:var(--vermelho); } ul { margin:4px 0; padding-left:20px; } li { margin:3px 0; }
.sugs { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px; } .sug { border:1px solid var(--sep); border-radius:12px; padding:10px 12px; } .sug-h { display:flex; justify-content:space-between; gap:8px; margin-bottom:4px; }
.chip { font-size:11px; border-radius:99px; padding:1px 8px; background:var(--ac2); white-space:nowrap; height:fit-content; } .chip.alto { background:rgba(217,48,37,.15); color:var(--vermelho); } .chip.medio { background:rgba(217,119,6,.15); color:var(--laranja); } .chip.baixo { background:rgba(31,157,85,.15); color:var(--verde); }
.vazio { color:var(--l3); } footer { color:var(--l3); font-size:12px; margin-top:20px; }
@media print { body { background:#fff; } .card, .kpi { break-inside:avoid; } }
</style></head><body><div class="wrap">
<header>
  <div><div class="mini">HARVEY · RECLAMAÇÕES DO MERCADO LIVRE</div><h1>Reclamações encerradas — últimos ${r.dias} dias</h1><div class="sub">${esc(nomeConta)} · dados coletados em ${r.atualizado_em ? new Date(r.atualizado_em).toLocaleString('pt-BR') : '—'}</div></div>
  <div class="mini">Gerado em ${geradoEm.toLocaleString('pt-BR')}</div>
</header>

<div class="kpis">
  <div class="kpi"><div class="l">Reclamações encerradas</div><div class="n">${r.total}</div></div>
  <div class="kpi"><div class="l">Reembolsado ao comprador</div><div class="n">${R$(r.reembolsado_total)}</div></div>
  <div class="kpi bom"><div class="l">Coberto pelo Mercado Livre</div><div class="n">${R$(r.coberto_ml)}</div><div class="mini">${r.reembolsado_total ? (Math.floor((r.coberto_ml / r.reembolsado_total) * 1000) / 10).toLocaleString('pt-BR') : 0}% do reembolsado</div></div>
  <div class="kpi ${r.prejuizo_direto > 0 ? 'ruim' : 'bom'}"><div class="l">Prejuízo direto</div><div class="n">${R$(r.prejuizo_direto)}</div><div class="mini">${r.qtd_sem_cobertura} caso(s) sem cobertura</div></div>
</div>

<section class="card"><h2>Quem ganhou</h2>
  <div class="placar"><div style="width:${pct(r.vendedor_ganhou, r.total)}%;background:var(--verde)"></div><div style="width:${pct(r.dividido, r.total)}%;background:var(--laranja)"></div><div style="width:${pct(r.comprador_ganhou, r.total)}%;background:var(--vermelho)"></div><div style="flex:1;background:var(--sep)"></div></div>
  <div class="leg"><span><i style="background:var(--verde)"></i>Vendedor ganhou: ${r.vendedor_ganhou} (${pct(r.vendedor_ganhou, decididas)}%)</span><span><i style="background:var(--laranja)"></i>Dividido: ${r.dividido}</span><span><i style="background:var(--vermelho)"></i>Comprador ganhou: ${r.comprador_ganhou} (${pct(r.comprador_ganhou, decididas)}%)</span><span><i style="background:var(--sep)"></i>Sem decisão: ${r.sem_decisao}</span></div>
  <p class="sub" style="margin:10px 0 0">Quando o comprador ganha, o Mercado Livre cobriu ${R$(r.coberto_ml)} (${r.qtd_coberto} casos). O prejuízo direto foi de ${R$(r.prejuizo_direto)}.</p>
</section>

${blocoIA}

<section class="card"><h2>Reclamações por mês</h2>${colunasMes(r.meses)}<div class="mini" style="text-align:center">em vermelho: prejuízo direto do mês</div></section>

<div class="grade">
  <section class="card"><h2>Principais motivos</h2>${barras(r.motivos.slice(0, 10), { rotulo: x => x.nome, valor: x => x.qtd, extra: x => `${x.qtd} · comprador ganhou ${x.comprador_ganhou}` })}</section>
  <section class="card"><h2>Produtos em que o comprador ganhou</h2>${barras(r.produtos.slice(0, 10), { rotulo: x => x.titulo || x.chave, valor: x => x.qtd, extra: x => `${x.qtd} · ${R$(x.reembolsado)}` })}</section>
  <section class="card"><h2>Como foram resolvidas</h2>${barras(r.por_resolucao.slice(0, 10), { rotulo: x => x.nome, valor: x => x.qtd, extra: x => String(x.qtd) })}</section>
  <section class="card"><h2>Por conta</h2>${barras(r.por_conta, { rotulo: x => x.nome, valor: x => x.qtd, extra: x => `${x.qtd} · reemb. ${R$(x.reembolsado)} · prejuízo ${R$(x.prejuizo)}` })}
    <h3>Por tipo</h3>${barras(r.por_tipo, { rotulo: x => x.nome, valor: x => x.qtd, extra: x => String(x.qtd) })}</section>
</div>

<section class="card"><h2>Prejuízo direto — reclamações sem cobertura do ML</h2>
${r.perdas.length ? `<table><tr><th>Data</th><th>Conta</th><th>Produto</th><th>Motivo</th><th>Resolução</th><th style="text-align:right">Valor</th></tr>
${r.perdas.map(p => `<tr><td>${new Date(p.data).toLocaleDateString('pt-BR')}</td><td>${esc(p.conta === 'flavia' ? 'Flavia' : 'Cordeiro')}</td><td>${esc(p.produto || '—')}</td><td>${esc(p.motivo)}</td><td>${esc(p.resolucao)}</td><td class="n">${R$(p.valor)}</td></tr>`).join('')}</table>` : '<div class="vazio">Nenhuma reclamação sem cobertura no período.</div>'}
</section>

<footer>Definições: reembolsado = valor devolvido ao comprador nos pedidos em que ele ganhou; coberto pelo ML = reembolsos com cobertura do Mercado Livre (não saem do bolso do vendedor); prejuízo direto = comprador ganhou e o ML não cobriu. Fonte: API de reclamações e pedidos do Mercado Livre. Harvey ${esc(versao)}.</footer>
</div></body></html>`;
}

module.exports = { gerar };
