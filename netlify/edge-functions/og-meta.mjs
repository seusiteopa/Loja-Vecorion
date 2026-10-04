// netlify/edge-functions/og-meta.mjs
//
// O WhatsApp (e qualquer rede social) não executa o JavaScript da página — só lê
// o HTML bruto antes de qualquer script rodar. Como o nome, a descrição, a logo,
// os banners e os produtos da loja só existem depois que o admin configura (e
// ficam guardados no servidor, não no arquivo), essa Edge Function intercepta a
// página ANTES de entregá-la e reescreve as tags <title>, description, og:title,
// og:description e og:image com os dados reais.
//
// Duas situações:
//
// 1) "/" (a loja em geral) — imagem escolhida nessa ordem: o primeiro banner
//    ativo que tiver foto; se não houver, a logo da loja; se não houver nenhuma
//    das duas, nenhuma tag og:image é adicionada (comportamento de hoje).
//
// 2) "/p/:id" (link de compartilhar um produto específico, gerado pelo botão
//    de compartilhar na página do produto) — usa o nome, a descrição curta e a
//    PRIMEIRA foto daquele produto. Essa rota não existe de verdade no servidor
//    (cai no mesmo index.html via redirect no netlify.toml); o próprio app,
//    assim que carrega, detecta "/p/:id" e entra direto na página do produto
//    certo — essa Edge Function só cuida de o link ter a prévia correta antes
//    de qualquer JavaScript rodar.
//
// Fora dessas duas situações (ex.: chamadas para /api/*, que não são HTML),
// a página passa direto, sem qualquer alteração.
//
// Qualquer erro aqui (armazenamento fora do ar, produto não encontrado, etc.)
// devolve a página original sem mexer em nada — isso nunca pode derrubar o site.

import { getStore } from '@netlify/blobs';

const CATALOG_STORE = 'vecorion-store';
const CATALOG_KEY = 'catalog';

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function replaceTag(html, pattern, replacement) {
  return pattern.test(html) ? html.replace(pattern, replacement) : html;
}

function siteLevelImage(data, siteUrl) {
  const banners = (data.banners || [])
    .filter((b) => b.ativo !== false && b.foto && b.foto.id)
    .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  if (banners.length) {
    return siteUrl + '/api/photo/banner/' + encodeURIComponent(banners[0].id) + '/' + encodeURIComponent(banners[0].foto.id) + '/f';
  }
  if (data.store && data.store.logoFoto && data.store.logoFoto.id) {
    return siteUrl + '/api/photo/loja/logo/' + encodeURIComponent(data.store.logoFoto.id) + '/f';
  }
  return '';
}

export default async (request, context) => {
  const response = await context.next();

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html;
  try {
    html = await response.text();
  } catch (err) {
    return response;
  }

  try {
    const doc = await getStore({ name: CATALOG_STORE }).get(CATALOG_KEY, { type: 'json' });
    const data = doc && doc.data;
    const store = data && data.store;

    if (store) {
      const siteUrl = new URL(request.url).origin;
      const pathMatch = new URL(request.url).pathname.match(/^\/p\/([^/]+)\/?$/);

      let nome = store.nome || 'Loja';
      let descricao = store.descricao || 'Loja online — escolha seus produtos e finalize o pedido pelo WhatsApp.';
      let imageUrl = '';

      if (pathMatch) {
        const productId = decodeURIComponent(pathMatch[1]);
        const produto = (data.products || []).find((p) => p.id === productId && p.visivel !== false);
        if (produto) {
          nome = produto.nome + (store.nome ? ' — ' + store.nome : '');
          descricao = produto.descricaoCurta || produto.descricaoCompleta || descricao;
          const foto = (produto.fotos || [])[0];
          if (foto && foto.id) {
            imageUrl = siteUrl + '/api/photo/produto/' + encodeURIComponent(produto.id) + '/' + encodeURIComponent(foto.id) + '/f';
          }
        }
      }

      if (!imageUrl) imageUrl = siteLevelImage(data, siteUrl);

      nome = escapeAttr(nome);
      descricao = escapeAttr(descricao);

      html = replaceTag(html, /<title>.*?<\/title>/, '<title>' + nome + '</title>');
      html = replaceTag(html, /<meta name="description" content=".*?">/, '<meta name="description" content="' + descricao + '">');
      html = replaceTag(html, /<meta property="og:title" content=".*?">/, '<meta property="og:title" content="' + nome + '">');
      html = replaceTag(html, /<meta property="og:description" content=".*?">/, '<meta property="og:description" content="' + descricao + '">');

      if (imageUrl) {
        const imgTag = '<meta property="og:image" content="' + escapeAttr(imageUrl) + '">';
        if (/<meta property="og:image"/.test(html)) {
          html = html.replace(/<meta property="og:image" content=".*?">/, imgTag);
        } else {
          html = html.replace('</head>', '  ' + imgTag + '\n  <meta name="twitter:card" content="summary_large_image">\n</head>');
        }
      }
    }
  } catch (err) {
    // armazenamento indisponível ou qualquer outro erro: devolve a página como veio, sem quebrar o site
    return new Response(html, response);
  }

  return new Response(html, response);
};

export const config = { path: ['/', '/p/*'] };
