import fs from 'node:fs';
fs.mkdirSync('site-dist/media', { recursive: true });
for (const file of ['index.html', 'style.css']) fs.copyFileSync(`site/${file}`, `site-dist/${file}`);
for (const file of ['demo.gif', 'demo-poster.png']) fs.copyFileSync(`docs/media/${file}`, `site-dist/media/${file}`);
fs.writeFileSync('site-dist/.nojekyll', '');
console.log('Static documentation built to site-dist/.');
