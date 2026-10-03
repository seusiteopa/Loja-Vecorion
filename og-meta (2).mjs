// netlify/edge-functions/og-meta.mjs
//
// O WhatsApp (e qualquer rede social) não executa o JavaScript da página — só lê
// o HTML bruto antes de qualquer script rodar. Como o nome, a descrição, a logo e
// os banners da loja só existem depois que o admin configura (e ficam guardados no
// servidor, não no arquivo), essa Edge Function intercepta a página ANTES de
// entregá-la e reescreve as tags <title>, description, og:title, og:description e
// og:image com os dados reais da loja.
//
// Imagem escolhida, nessa ordem: o primeiro banner ativo que tiver foto; se não
// houver, a logo da loja; se não houver nenhuma das duas, nenhuma tag og:image é
// adicionada (comportamento de hoje).
//
// Roda só na rota "/" — como o roteamento interno da loja usa #hash (depois do
// endereço), o navegador nunca manda essas rotas pro servidor; toda primeira
// visita bate em "/" de qualquer forma.
//
// Qualquer erro aqui (armazenamento fora do ar, etc.) devolve a página original
// sem mexer em nada — isso nunca pode derrubar o site.

import { getStore } from '@netlify/blobs';

const CATALOG_STORE = 'vecorion-store';
const CATALOG_KEY = 'catalog';

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function replaceTag(html, pattern, replacement) {
  return pattern.test(html) ? html.replace(pattern, replacement) : html;
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
    const store = doc && doc.data && doc.data.store;

    if (store) {
      const nome = escapeAttr(store.nome || 'Loja');
      const descricao = escapeAttr(store.descricao || 'Loja online — escolha seus produtos e finalize o pedido pelo WhatsApp.');
      const siteUrl = new URL(request.url).origin;

      let imageUrl = '';
      const banners = (doc.data.banners || [])
        .filter((b) => b.ativo !== false && b.foto && b.foto.id)
        .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
      if (banners.length) {
        imageUrl = siteUrl + '/api/photo/banner/' + encodeURIComponent(banners[0].id) + '/' + encodeURIComponent(banners[0].foto.id) + '/f';
      } else if (store.logoFoto && store.logoFoto.id) {
        imageUrl = siteUrl + '/api/photo/loja/logo/' + encodeURIComponent(store.logoFoto.id) + '/f';
      }

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

export const config = { path: '/' };
