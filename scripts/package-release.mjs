import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!process.env.npm_execpath) throw new Error('Run npm run package:release.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Tag/package version mismatch.');
const out = path.resolve('release'); fs.mkdirSync(out, { recursive: true });
const manifest = JSON.parse(fs.readFileSync('dist/extension/manifest.json', 'utf8'));
if (manifest.version !== pkg.version || JSON.stringify(manifest.permissions) !== JSON.stringify(['activeTab', 'scripting', 'storage']) || manifest.host_permissions) throw new Error('Unexpected extension manifest.');
const extensionFiles = ['manifest.json', 'popup.css', 'popup.html', 'popup.js', 'service-worker.js'];
if (JSON.stringify(fs.readdirSync('dist/extension').sort()) !== JSON.stringify(extensionFiles)) throw new Error('Unexpected extension output.');
const zipped = {};
for (const name of extensionFiles) zipped[name] = [fs.readFileSync(`dist/extension/${name}`), { mtime: new Date(1980, 0, 1), level: 9 }];
const zipName = `why-ui-extension-v${pkg.version}.zip`;
fs.writeFileSync(path.join(out, zipName), zipSync(zipped));
const [pack] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', out], { encoding: 'utf8', windowsHide: true }));
for (const { path: file } of pack.files) {
  if (!/^(?:bin\/|dist\/|docs\/|README\.md$|LICENSE$|package\.json$)/.test(file) || /(?:auth\.json|node_modules|test-results|\.env|\.map$)/.test(file)) throw new Error(`Disallowed package entry: ${file}`);
  if (/\.(?:js|json|ts|md|html|css)$/.test(file)) {
    const body = fs.readFileSync(file, 'utf8');
    if (/-----BEGIN .*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|[A-Z]:[\\/](?:Users|home)[\\/]/.test(body)) throw new Error(`Sensitive or machine-specific package content: ${file}`);
  }
}
const names = [zipName, pack.filename].sort();
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), names.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex')}  ${name}\n`).join(''));
console.log(`Release artifacts: ${names.join(', ')}, SHA256SUMS.txt`);
