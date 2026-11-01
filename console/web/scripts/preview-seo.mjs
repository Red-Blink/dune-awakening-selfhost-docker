import fs from 'node:fs';
import path from 'node:path';

const origin='https://try.dunedocker.app/';
const title='Try Dune: Awakening Server Console Online | Dune Docker';
const description='Explore Dune Docker Console with sample data: live maps, players, backups, server controls, and more. Try it in your browser with no installation.';

export function applyPreviewSeo(out){
  const file=path.join(out,'index.html');
  const structured={
    '@context':'https://schema.org',
    '@graph':[
      {'@type':'WebSite','@id':origin+'#website',url:origin,name:'Dune Docker Console Preview',inLanguage:'en'},
      {'@type':'WebApplication','@id':origin+'#application',url:origin,name:'Dune Docker Console',applicationCategory:'UtilitiesApplication',operatingSystem:'Web Browser',isAccessibleForFree:true,description,
        isPartOf:{'@id':origin+'#website'},publisher:{'@type':'Organization',name:'Dune Docker',url:'https://dunedocker.app/'}}
    ]
  };
  let html=fs.readFileSync(file,'utf8');
  html=html.replace(/<title>[^<]*<\/title>/,`<title>${title}</title>`);
  html=html.replace('</head>',`<meta name="description" content="${description}">
    <link rel="canonical" href="${origin}">
    <meta name="robots" content="index, follow, max-image-preview:large">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Dune Docker">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${origin}">
    <meta property="og:image" content="${origin}images/features/five_survivors.png">
    <meta property="og:image:alt" content="Dune: Awakening survivors and a Regis Tank">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${origin}images/features/five_survivors.png">
    <script type="application/ld+json">${JSON.stringify(structured)}</script>
  </head>`);
  html=html.replace('<div id="root"></div>',`<div id="root"><main><h1>Try the Dune: Awakening Server Console</h1><p>${description}</p><p>This read-only preview uses fictional sample data. Server management actions are disabled.</p><p><a href="https://dunedocker.app/">Dune Docker</a> · <a href="https://docs.dunedocker.app/">Installation and Documentation</a> · <a href="https://blueprints.dunedocker.app/">Dune: Awakening Base Builder</a></p><noscript>Enable JavaScript to explore the interactive Console. You can still follow the links above to learn about the project.</noscript></main></div>`);
  fs.writeFileSync(file,html);
  fs.writeFileSync(path.join(out,'robots.txt'),`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /health\n\nSitemap: ${origin}sitemap.xml\n`);
  fs.writeFileSync(path.join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}</loc></url></urlset>\n`);
}
